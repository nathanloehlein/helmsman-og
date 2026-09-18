# Repository workflow

- The user has authorized committing and pushing completed Helmsman changes to GitHub. After each completed change, run appropriate validation, commit, review the commit as a Senior Software Architect, fix any material findings, and push to the branch's upstream. Do not ask for push permission again unless the user revokes this authorization.
- The canonical remote is `godaddy` (`https://github.com/nloehlein-godaddy/helmsman.git`); `master` tracks `godaddy/master`. For a branch without an upstream, push that branch to `godaddy` and set its upstream.
- Verify the push succeeded and report the commit. Do not claim GitHub is updated while changes remain local. If validation or pushing is blocked, report the blocker.
- Never force-push, bypass branch protections, commit secrets or runtime data, or include unrelated user changes. This authorization does not permit merging another branch into `master`.
