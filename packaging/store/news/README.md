# What's new, one change at a time

A change users will see adds one Markdown file here in its own pull request,
named for the change, for example `ssh-jump-host.md`. Each file has exactly one
`<language>: …` line per listing language (the language of `listing-*.md`:
English only today). Blank lines are allowed; duplicate, missing and unknown
language lines are refused with the file name.

```text
en: Reach SSH hosts through a jump host.
```

A release sends one bullet per file added since the previous release, in file-name
order, after `Version <version>` and before the link to the GitHub release.
`README.md` is excluded. Released files stay: editing an old fragment does not
add it to a later release, and deleting or renaming one makes the release's
listing check fail. Keep each change short: the entire What's new must fit in
1,500 characters. A new listing language needs a line in every fragment added
after it and a What's new frame in `FRAME` of `scripts/store-listing.ts`; without
the frame the listing check refuses that language.

With no added fragment the uploaded package waits as a Partner Center draft;
someone must write its What's new there and submit it. Rerunning the workflow
checks out the same frozen commit and cannot add missing news.
