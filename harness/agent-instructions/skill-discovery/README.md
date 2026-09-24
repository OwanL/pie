# cwd-skills

Auto-discovers skills from a `skills/` directory in the current working directory.

## How it works

When pi starts, this extension checks if `./skills/` exists. If found, it registers that path as a skill directory, making all skills inside available to the agent.

## Usage

Just place skill directories in `./skills/` within your project:

```
your-project/
├── skills/
│   ├── my-skill/
│   │   └── SKILL.md
│   └── another-skill/
│       └── SKILL.md
└── ...
```

Skills are automatically discovered—no configuration needed.
