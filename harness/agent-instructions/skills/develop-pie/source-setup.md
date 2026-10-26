# Source setup, only when needed

Read this only when Pie source changes are necessary and no suitable checkout exists. Ordinary supported customisation needs neither source nor a rebuild; use `customize-pie` first.

## Choose source before obtaining it

1. Identify the running application's installed version and selected runtime using available installation/profile information. A package version alone does not identify built runtime bytes; inspect the verified runtime's `pi-runtime/manifest.json` where available. Do not infer an application source revision from a runtime package version alone.
2. Locate an existing checkout matching the installed release, or ask the user to choose an explicitly newer version for development. Latest main is not assumed to match the installed app. Matching-release source lookup/acquisition is not yet a qualified end-user workflow: if provenance cannot be established from current version/configuration and release evidence, ask for the source choice. Do not invent a release URL, metadata field, download command or UI action.
3. With approval to acquire source, use an independently located checkout at the chosen revision, separate from installed application files. Use an ordinary branch, not a new Git worktree. Follow machine/repository directory rules. Do not automatically clone, download, install prerequisites or fetch dependencies merely because this guide was loaded.

All paths below are relative to **the chosen source checkout**. They are not bundled-skill-relative links. Read its `AGENTS.md` if present, `README.md`, `docs/DOCUMENTATION-POLICY.md`, relevant contracts, and `harness/pi-runtime/README.md`; follow that revision's actual scripts/toolchain authorities rather than assuming this guide identifies future versions.

## Prepare a private development route

- Inspect `.prototools`, `.node-version`, root `package.json` and the shared lockfile. Use the repository-pinned Proto/pnpm toolchain; do not install global wrappers or substitute an arbitrary SDK. Check existing prerequisites before requesting installation. Never bypass frozen dependency setup or its workspace writer gate.
- The current dependency-only route is `proto run pnpm -- run setup` from the source root. It is an explicit dependency operation, not automatic permission to acquire anything. Do not default to legacy `install.bat`: its migration and installed-configuration behavior is not needed merely to obtain source.
- Select focused tests and checks with `develop-pie`. Build and host launch are separate approved steps: `proto run pnpm -- run build` writes local `application/hosts/vscode/out-dev`; `proto run pnpm -- run dev` or `proto run pnpm -- run dev:vscode` launches the isolated development host. These are not installation or publication commands.
- Development launch uses a checkout-specific private profile for settings, auth, history, data and host state. Inspect the printed profile and configure it deliberately; never silently copy personal settings, credentials or history. Ambient provider environment variables may still be inherited, so isolation is not a credential sandbox or permission for provider calls.
- Preserve the installed host. Separate development profiles do not authorise simultaneous normal hosts. Respect host ownership and active workspace readers: stop the isolated host before backend/Pi rebuild, build, then relaunch. Never bypass gates, reclaim registrations by PID/age, or delete gate state because teardown is uncertain.

## Obtained, built and activated are separate

Obtaining source, installing dependencies, testing and building do not replace or activate the installed application. Do not patch immutable runtime generations. Delivery, publication and loader activation need their own explicit decision and the owning checkout's build/run instructions. Built, staged, loaded and behavior-verified remain different states; preserve runtime artifact identity, data/storage authority and existing recovery contracts. Product rename and public release are not complete.

Return to [develop-pie](SKILL.md) for source contracts, commands, artifact verification and host/delivery rules.
