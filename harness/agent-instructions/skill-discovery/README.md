# cwd-skills

Auto-discovers skills from a `skills/` directory in the current working directory.

## How it works

At pi startup and again on every reload (`resources_discover` with reason `startup` or `reload`), this extension checks whether the current working directory has a `skills/` directory. If found, it registers that path as a skill directory, making all skills inside available to the agent.

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
