from aiohttp import web
import asyncio

async def echo(request: web.Request) -> web.StreamResponse:
    print("echo: got request")
    response = web.StreamResponse(status=200, headers={"content-type": "text/event-stream"})
    await response.prepare(request)
    chunks = [
        'data: {"id":"e1","object":"chat.completion.chunk","created":1,"model":"umans-glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":"h"}}]}\n\n',
        'data: {"id":"e1","object":"chat.completion.chunk","created":1,"model":"umans-glm-5.2","choices":[{"index":0,"delta":{"content":"i"}}]}\n\n',
        'data: {"id":"e1","object":"chat.completion.chunk","created":1,"model":"umans-glm-5.2","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
    ]
    for c in chunks:
        await response.write(c.encode("utf-8"))
        await asyncio.sleep(0.05)
    print("echo: wrote all chunks")
    return response

app = web.Application()
app.router.add_post("/v1/chat/completions", echo)

if __name__ == "__main__":
    web.run_app(app, host="127.0.0.1", port=4001, print=lambda *a, **k: None)
