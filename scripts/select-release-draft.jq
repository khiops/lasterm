# Which draft release create-release keeps for a tag, and which it deletes.
#
# Input: the repository's releases, as one array.
# Arguments:
#   $tag     the tag being released
#   $sha     the commit the run froze
#   $tagged  "true" when the tag already exists on the remote (and was checked
#            to point at $sha), "false" otherwise
#
# Output, one of:
#   {"keep": null, "delete": []}           no draft: create one
#   {"keep": <id>, "delete": [<id>, ...]}   reuse <id>, delete the others
#   {"error": "...", "drafts": [...]}       refuse; nothing may be deleted
#
# A draft is chosen by what it targets, never by where the API happened to
# list it (#270). Deleting a draft is irreversible and takes release-please's
# changelog body with it, so nothing is deleted unless the one kept is known
# to be right.

[.[] | select(.tag_name == $tag and .draft)] as $drafts
| ($drafts | map(select(.target_commitish == $sha)) | sort_by(.id)) as $matches
| if ($drafts | length) == 0 then
    {keep: null, delete: []}
  elif ($matches | length) > 0 then
    # Duplicates aimed at the same commit are interchangeable; the oldest is
    # kept so the choice does not depend on listing order.
    {keep: $matches[0].id, delete: [$drafts[] | select(.id != $matches[0].id) | .id]}
  elif $tagged == "true" and ($drafts | length) == 1 then
    # Once the tag exists GitHub ignores target_commitish, and the tag was
    # checked against $sha. A single draft for it is unambiguous: this is a
    # published release turned back into a draft for a rebuild.
    {keep: $drafts[0].id, delete: []}
  else
    {
      error: "no draft release for \($tag) targets \($sha); refusing to pick one by position",
      drafts: [$drafts[] | {id, target_commitish}]
    }
  end
