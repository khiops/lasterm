# Contributing to lasterm

## Before you start

Open an issue before a change that adds a feature or touches the protocol, so the
design can be agreed before the code. Bug fixes and documentation can go straight to a
pull request.

Report a security problem privately, as [`SECURITY.md`](SECURITY.md) explains, never in
a public issue.

## Sign your commits (DCO)

Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/): inbound =
outbound, under the license of the component you change (AGPL-3.0-only for the
application, MIT OR Apache-2.0 for the standalone libraries). There is no CLA.

Every commit carries a `Signed-off-by:` line with your real name and the email of the
commit author. `git commit -s` adds it, and `git rebase --signoff <base>` signs the
commits already on a branch.

## Before you open a pull request

```sh
pnpm install
scripts/dev/check.sh   # everything CI checks on a pull request, one log per step
```

`README.md` § Development lists the prerequisites and the single-package commands.
