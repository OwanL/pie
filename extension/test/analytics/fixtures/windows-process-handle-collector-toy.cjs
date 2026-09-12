const mode = process.argv[2] || 'natural';
const allocation = Buffer.alloc(16 * 1024 * 1024);
for (let index = 0; index < allocation.length; index += 4096) allocation[index] = 0x5a;
if (mode === 'natural') setTimeout(() => process.exit(0), 500);
else setInterval(() => {}, 1000);
