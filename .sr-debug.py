import json

path = 'data/outcomes/sessions/2026-07-29T02-05-01-991Z_019fab9e-3ca7-76ff-adc9-b157159b40e9.jsonl'
count = 0
with open(path, 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        msg = d.get('message', {})
        if msg.get('role') == 'toolResult' and msg.get('toolName') == 'subagent':
            details = msg.get('details', {})
            res = details.get('results', [])
            if not res:
                continue
            r = res[0]
            tcid = msg.get('toolCallId')
            # Check what fields exist
            print(f'=== {tcid} ===')
            print(f'  finalOutput: {repr(r.get("finalOutput", "")[:100])}')
            print(f'  messages count: {len(r.get("messages", []))}')
            for m in r.get('messages', []):
                role = m.get('role')
                c = m.get('content', '')
                if isinstance(c, list):
                    for part in c:
                        if isinstance(part, dict) and part.get('type') == 'text':
                            print(f'  msg[{role}] text: {repr(part.get("text","")[:150])}')
                            break
                elif isinstance(c, str):
                    print(f'  msg[{role}] str: {repr(c[:150])}')
            count += 1
            if count >= 2:
                break
