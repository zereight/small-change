# small-change

Decides whether a Bitbucket Cloud pull request is a *small change*: small enough, and low-risk
enough, to skip a full review. It reads the PR through the Bitbucket API, checks five rules, prints
which ones hold, and exits with a code a pipeline can act on.

```sh
small-change https://bitbucket.org/team/platform/pull-requests/128 --kind backend
```

```
team/platform#128 "Round invoice totals to the currency's minor unit" by Alice

PASS  size             55 lines changed (must be fewer than 1000)
FAIL  review-findings  1 unresolved finding(s) matching /\bP[12]\b/i
      - #9 review-bot: **P2** Rounding differs for JPY
SKIP  author-history   not checked: another check already failed
PASS  services         2 affected service(s) (must be fewer than 3)
      - libs/money
      - services/billing
FAIL  exclusions       1 changed path(s) excluded
      - libs/money/index.ts (excluded by "libs/")

Result: not a small change
```

Exit code `0`: a small change. `1`: not a small change. `2`: usage error, or Bitbucket could not be
read.

The check itself calls no LLM. A separate `review` command can have an agent CLI you are already
logged in to (Claude Code, Cursor's `agent`, Codex, Pi, or Muse Code) review the PR and post findings that the
check then counts; see [Reviewing with an LLM](#reviewing-with-an-llm).

## How a run works

![The workflow of one small-change run: read the pull request from Bitbucket, run four local checks, run the author-history check only if they pass, then report and exit](docs/workflow.png)

The diagram's source is [`docs/workflow.puml`](docs/workflow.puml).

## The rules

A PR is a small change only if **all** of these hold.

| Rule | Default | Options |
| --- | --- | --- |
| **size**: fewer than N lines changed, added plus removed | 1000 | `--max-lines` |
| **review-findings**: no unresolved P1 or P2 finding from the automated review | `\bP[12]\b`, any commenter | `--bot`, `--finding-pattern` |
| **author-history**: the author has merged at least N PRs in *each* affected service | 10 | `--min-merged`, `--history-limit` |
| **services**: fewer than N affected services | frontend 2 (one at most), backend 3 (two at most) | `--kind`, `--max-services`, `--service-depth` |
| **exclusions**: no changed path is listed in `.small_change` | none excluded | |

`--kind frontend|backend` picks the service limit of the monorepo; `--max-services <n>` sets it
directly. One of the two is required.

The author-history check reads many PRs, so it runs only when the other four pass. When one of
them fails, it is reported as `SKIP`: the PR is not a small change whatever the history says.

### Excluding paths: `.small_change`

Shared libraries and sensitive paths (anything that moves money, say) never qualify. List them in a
`.small_change` file at the repository root. It follows the core of `.gitignore` syntax:

```gitignore
# shared libraries
libs/
packages/design-system/

# money movement, wherever it sits in the tree
payments
**/ledger/**

# the root build files
/Makefile
*.lock
```

- `#` starts a comment; blank lines are ignored.
- A trailing `/` matches directories only. A pattern that names a directory covers everything under it.
- A pattern with a `/` at the start or in the middle is anchored to the repository root; one without
  matches at any depth.
- `*` and `?` stay within one path segment; `**` crosses segments.
- Negation (`!`) is refused with an error, because ignoring it would silently widen what counts as
  small.

The file is read from the **destination branch**, never from the PR, and a PR that changes
`.small_change` itself is never a small change. Otherwise a PR could lift its own exclusions.

## Install

Requires Node.js 24 or later. The package is not on npm, and nothing needs installing: `npx` runs
it straight from this repository.

```sh
npx --yes github:zereight/small-change --help
npx --yes github:zereight/small-change <PR URL> --kind backend
```

Every run asks GitHub for the latest commit before it starts, so a new commit is picked up on its
own. The tool starts after about 7 seconds, and the first run after about 9 (measured from one
machine). To stay on one version, name a commit or tag: `github:zereight/small-change#<commit>`;
that is not faster. The commands below are written as `small-change ...`;
with `npx` that is `npx --yes github:zereight/small-change ...`.

To work on the code, clone it:

```sh
git clone https://github.com/zereight/small-change.git
cd small-change
npm install        # also builds, through the `prepare` script
node dist/cli.js --help
```

## Authentication

Set `BITBUCKET_TOKEN` to a token that can read the repository's pull requests and contents. It is
sent as a `Bearer` token to `api.bitbucket.org` only, and never printed. Bitbucket accepts Bearer
authentication for both kinds of token, so either works, and no email address is needed:

- an **access token** for the repository, project or workspace (scopes: pull requests read,
  repository read); this one has its own bot identity, separate from any person;
- an Atlassian account **API token** (scopes `read:pullrequest:bitbucket` and
  `read:repository:bitbucket`); this one acts as the account that owns it.

Bearer authentication has been tried against a private repository. If your token lives in another
variable, map it: `export BITBUCKET_TOKEN="$BITBUCKET_API_TOKEN"`.

Public repositories work without a token, but Bitbucket limits anonymous requests heavily (HTTP
429). One run makes about five requests, plus, for the author-history check, one per page of the
author's PR list and two for each PR it reads.

### Naming the review bot

`--bot` takes the name, nickname or UUID of whoever posts the review comments, and Bitbucket Cloud
has no separate "bot" object: the author is the identity of the token the automation uses. With an
access token it is the token's own bot identity; with a personal API token it is that person, so
their human comments would match too. In that case narrow `--finding-pattern` to the format only the
automation writes.

To see who commented on a PR, with their type, name and UUID:

```sh
curl -s -H "Authorization: Bearer $BITBUCKET_TOKEN" \
  "https://api.bitbucket.org/2.0/repositories/<workspace>/<repo>/pullrequests/<id>/comments?pagelen=100" \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const u of new Set(d.values.map(c=>[c.user.type,c.user.display_name,c.user.uuid].join("\t"))))console.log(u)'
```

The name is compared exactly (case and braces ignored). A name that matches nobody reads as "no
findings", so check the spelling.

## Reviewing with an LLM

`small-change review` has an agent CLI read the PR's diff and report problems, graded **P1** (must
fix), **P2** (should fix) and **P3** (minor). No API key is involved: it drives the CLI you are
logged in to, headless.

| Provider | CLI | Models | How the budget is applied |
| --- | --- | --- | --- |
| `claude` | `claude` | Cannot be listed; aliases are suggested (`opus`, `sonnet`, `haiku`, ...) | `--effort` |
| `cursor` | `agent` | `agent --list-models` | The effort is part of the model slug (`grok-4.7-xhigh`), so the budget swaps the slug |
| `codex` | `codex` | `codex debug models` | `-c model_reasoning_effort=...`, clamped to what the model supports |
| `pi` | `pi` | `pi --list-models` (extensions included), as `provider/model` | `--thinking`; a model without thinking gets no effort |
| `muse` | `muse` | Cannot be listed; `muse-spark-1.3` is suggested | `--reasoning-effort` |

### Choosing the model: `small-change model setup`

```sh
small-change model setup                # asks for provider, model and budget
small-change model setup --provider cursor --model grok-4.7-low --budget large --yes   # for a script
small-change model list                 # the models of every installed CLI
small-change model show                 # the saved choice
```

Setup detects the CLIs on PATH and their models, starts from the saved choice, applies the budget,
shows the result, and asks to confirm. Before saving, it sends a one-word request with the chosen
model, so a model the account rejects is never saved (`--no-verify` skips this). The file is
rewritten whole, so running setup again gives the same result.

| Budget | Effort |
| --- | --- |
| `unlimited` | max |
| `large` | xhigh |
| `medium` | high |
| `small` | medium |

When a model does not offer the effort, the highest one below it is used: `unlimited` on a model
that stops at `high` means `high`. Setup prints the slug or effort it ended up with.

The choice is saved in `$XDG_CONFIG_HOME/small-change/config.json`, else
`~/.config/small-change/config.json`; `--config <file>` overrides it for any `model` or `review`
command. The choice above is the reviewer; a second model can be added as the verifier, see
[A second opinion](#a-second-opinion-the-verifier).

### Running a review

```sh
small-change review https://bitbucket.org/team/platform/pull-requests/128            # print findings
small-change review https://bitbucket.org/team/platform/pull-requests/128 --post     # and comment
```

`--post` posts each finding as a comment that opens with `**P1** <title>`, so the default
`--finding-pattern` of the check counts it. Name the posting identity in the check with `--bot`.
Posting needs `BITBUCKET_TOKEN` with write access to pull requests. A finding is skipped when a
comment on the PR already opens with the same line, so running the review twice does not post
twice. Other flags: `--language`, `--max-findings`, `--max-diff-bytes`, `--context-bytes`,
`--context-lines`, `--no-verifier`, `--timeout`, `--json` (print the result as JSON), and
`--search`, `--max-lookups` (see "Looking up more code").

### What a comment looks like

Each finding is one general comment on the PR, and it holds only the grade, the title, the place,
the condition and the evidence, in English and Korean:

```markdown
**P2** Session is refreshed on every login
로그인할 때마다 세션이 갱신됨

`packages/app/src/session.ts:94`

Condition: the user logs in twice without restarting the app
조건: 앱을 다시 시작하지 않고 두 번 로그인할 때

Evidence / 증거:
- `packages/app/src/session.ts:94` `await refreshSession()`
```

A part that a finding does not have (the condition, the evidence, a translation) is left out. The
detail, why a grade was lowered, what the second reviewer said, which model wrote it and which
engine looked things up are not in the comment; they are in the output of `review` and in `--json`.
The first line is also what keeps a rerun from posting twice. `@` mentions and Markdown images in
the model's text are defused.

`--language` takes up to three names separated by commas (default `English,Korean`). The reviewer
writes in the first and adds a translation of each title and condition in the others; the labels
are translated for Korean only and stay English for other languages. A finding the reviewer sent
without a translation is posted in the first language, and the output says how many.
`--language English` posts English only.

The check counts a comment when `\bP[12]\b` matches anywhere in it, not only in the first line. A
P3 or a question whose text names a grade ("this is not a P1") would therefore be counted, and
block the merge it was lowered to avoid blocking. In those comments the digit is written with an
invisible character after the `P` (`P` + U+200B + `1`): it reads the same, and the pattern does not
match. Comments posted before this was fixed still have the plain text, and some of them carry
"Graded P3, not P1"; resolve them in Bitbucket, since resolved comments are not counted.

### What a P1 or P2 needs

P1 and P2 are what the check counts, so a wrong one blocks a merge. The reviewer therefore has to
prove them, and the proof is checked by this tool, not by the model:

| Grade | Meaning | Counted by the check |
| --- | --- | --- |
| `P1` | must be fixed before merge | yes |
| `P2` | should be fixed | yes |
| `P3` | minor, or a gap whose trigger is not shown | no |
| `ASK` | a question to the author | no |

A P1 or P2 keeps its grade only when it has a `condition` (the input or state sequence that
triggers it) and at least one `evidence` quote that is found word for word, in the right file, in
what the reviewer was shown (the diff and the code around it; quotes under 10 characters do not
count). A defect that needs a run-time event (a throw, a false return, a screen that is gone)
needs a `firing` quote that shows the event too. One that rests on a server contract or on code
that was not shown becomes an `ASK`. Anything else is posted as a P3 with a line saying which
grade it was lowered from and why, and the output prints `lowered from ...`.

What this does not do: a quote proves that the code exists, not that the conclusion follows from
it. A finding with real quotes can still be wrong, for example when a comment in the code says the
behavior is deliberate. The prompt asks the reviewer to try to refute each P1 and P2 first, but
nothing checks that it did. A second model can be asked to, see the next section.

### A second opinion: the verifier

```sh
small-change model setup --role verifier --provider claude --model opus --budget medium
small-change model setup --role verifier --remove      # take it away again
```

With a verifier saved, every P1 and P2 the reviewer reports is shown to the second model, along
with the same diff and code, and the job of refuting it. The verifier must answer for each finding
with `upheld`, `refuted` or `unclear`. A refutation counts only with a reason and a `counter`
quote that is found in what was shown, the same bar the finding itself had to clear; without it
the verdict is `unclear`. A refuted finding is posted as a P3, so it does not
count for the check. The comment does not say who refuted it; the output of `review` does, with
the reason and the quote, and so it does for the ones that stayed (`second reviewer: unclear: ...`)
and for which model checked (`checked by claude/opus`).

- Choose a model other than the reviewer's; the setup says so when they are the same. Use
  `--no-verifier` on a single `review` to skip it.
- It runs only when there is a P1 or P2 to check, so a clean review costs no second request.
- It is a part of the review, not an extra: if the verifier fails (not installed, a timeout, an
  answer that is not the expected JSON), the review stops and posts nothing, rather than posting
  grades that were never checked.
- It sees only what the reviewer saw. A finding that is wrong because of code outside the PR (for
  example, an import that is fine because other files in the repository do the same) cannot be
  refuted from the diff and the changed files, and stays `unclear`. On a real PR, a wrong P1 and a
  wrong P2 of that kind survived two of six runs. The verifier's reasons were not printed in those
  runs yet, so that this is the cause is likely, not confirmed.
- A quote that exists is not proof that it says what the verifier claims. A refutation can rest on
  a real but loosely related comment, and a real bug can be refuted wrongly. Refuted findings are
  posted, not dropped, so that a person can see it.

### The code around the change

The diff alone shows 3 lines around each change, so a finding about the rest of the file would be
a guess. This tool reads each changed file at the PR's source commit through the Bitbucket API and
shows the reviewer the whole file when it is up to 16000 bytes, else the `--context-lines` lines
(default 40) around each change, up to `--context-bytes` in all (default 120000; `0` shows the
diff only). Not shown, and listed with the reason in the prompt and in the output: deleted and
binary files, new files (the diff already has all of them), lock files, generated and minified
files, a file that cannot be read, and what does not fit in the size limit. The reviewer still has
no tools; only the files of the PR itself are read, and they are fenced as data like the diff.
(`--search` lets it ask for more; the agent still has no tools, see the next section.)

What keeps an untrusted PR from steering the review:

- The agent runs in an empty temporary directory with its tools off (Claude, Pi), read-only and in
  `ask` mode with a sandbox (Cursor), in a read-only sandbox (Codex), or with `--yolo` but shell,
  file writes, web tools and questions switched off in the bare `empty` preset (Muse). Pi also
  runs with skills, context files and MCP servers off. It is given the prompt only.
- Pi and Muse are the exception to "sandboxed". Pi runs as the local install is set up, so its
  extensions load, and Muse runs with `--yolo`, which turns off its approval prompts and sandbox.
  What holds them back is the tool-off flags, not a sandbox. One file read was tried on each, a
  file inside the workspace and one outside it: neither Pi (through `claude-bridge`) nor Muse read
  it. Two attempts are not proof that no tool call can get through.
- Its environment has no `BITBUCKET_*` variable, so it never holds the token that can comment.
  Posting is done by this tool, never by the agent.
- The title, description, diff and the code of the changed files sit between markers that are random on every run, and the agent
  is told they are data to review, not instructions. This lowers the risk; it does not remove it.
  An author can still word a diff to talk a model into reporting nothing, so a clean review is
  not proof that a PR is safe.
- Anything the agent writes is treated as text: `@` mentions and Markdown images are defused before
  posting, and each field is length-limited. An answer that is not the expected JSON posts nothing.
- A diff over `--max-diff-bytes` (default 300000) is refused, not cut: a review of part of a PR
  would read as a review of all of it.

Limits observed on a real machine:

- Codex's model catalog lists models that a ChatGPT login rejects (`model_not_found`). Setup's
  one-word request catches this and saves nothing. Every Codex model tried here was rejected, so a
  full Codex run has not been seen to succeed.
- Pi loads the local extensions, so `claude-bridge/*` models work. That provider starts Claude Code
  with `permissionMode: "bypassPermissions"` and does not ignore the user's own Claude settings, as
  the `claude` provider does: a plugin's note about its memory log showed up in one answer. Use
  `--provider claude` when a clean Claude run matters more than going through Pi.
- A model can be listed and still fail: `cursorapi/composer-2.5` was listed by Pi and answered
  `Connection error`, and the one-word request refused to save it.
- Muse has no command to list models and accepts any model id in `model-profile`, so only a
  request tells whether a model works: `muse-spark-1.3` did here, `muse-wonder-1.0` was refused
  for this account. Muse still loads the user's installed skills (115 here) into the run, even with
  the `empty` preset and without other tools' skills; the prompt is larger than it needs to be.
- For Cursor, a slug with no effort token (`gpt-5.3-codex`, `auto`, `composer-2.5`) is used as it
  is, whatever the budget.
- `--post` has not been run against a real PR.

## Looking up more code: `--search`

A finding often rests on code the diff and the changed files do not show: who else calls a
function, whether the same import is used elsewhere, what a definition says. With `--search off`
the agent can only guess. By default the agent may answer its first turn with
`{"lookups":[...]}` instead of findings. This tool runs the lookups on a checkout of the PR's source
commit, adds the answers to the material and gives the agent one more turn, in which it must answer.
The verifier gets the same offer. A quote copied from a lookup result counts as proof like a quote
from the diff, so a refutation can cite a file that the PR does not touch.

```sh
small-change review <pr-url>                          # --search auto: tgrep, else git grep
small-change review <pr-url> --search off             # the agents get the diff and the changed files only
small-change review <pr-url> --search git-grep --max-lookups 12
```

The default, `auto`, is [tgrep](https://github.com/microsoft/tgrep) 1.2.6 or newer. Install the
latest with `brew install tgrep` (or `brew upgrade tgrep`). When it is not on `PATH`, or is older,
`auto` uses `git grep` and the output says so. A named engine that is not installed is an error,
not a fallback.

| Kind | Asks for | Engines |
| --- | --- | --- |
| `grep` | lines containing a text, or matching a regular expression; optional `glob` (`*.kt`, `src/**/*.ts`) and `ignoreCase` | all |
| `file` | lines of one file (at most 200 per request) | all |
| `callers` | the symbols that call a function, with the lines of the calls | `graft` |
| `skeleton` | the signatures in a file, without bodies | `graft` |

Each agent asks for at most `--max-lookups` (default 8) per turn. One answer shows at most 40 hits
or lines and 12000 characters, and all answers of a review together at most 60000; what is cut is
counted in the output. Each agent that asks costs one more model run.

How it stays safe, as the PR is untrusted:

- The agent has no tools. A lookup is JSON that this tool validates (pattern of 3 to 200
  characters without line breaks, a glob that cannot leave the repository, a path without `..`, a
  symbol name that is an identifier) and then runs itself. Nothing the agent writes becomes a
  command line.
- The checkout is `git init` and `git fetch --depth 1` of one full commit hash into a temporary
  directory: no history, no tags, no submodules. Git runs with no system or user configuration, with
  hooks switched off, no prompts and no credential helper. Links are checked out as plain files, and
  files are read through `git cat-file` at the commit, so a link cannot lead out of the directory.
- The token goes to the fetch only, as a Basic `x-token-auth` header in git's environment
  configuration, never in an argument. Bitbucket accepts a Bearer token for its API but not for git
  over HTTPS. The search programs get `PATH` and nothing else; the agents get no `BITBUCKET_*`.
- The checkout is deleted when the review ends, also when it fails. If it cannot be made (a private
  fork, no network, a broken index), the review goes on without lookups and the output says why.
- Lookup results are code written by the PR's author. They sit in the material like the diff and
  are fenced as data.

### The engines

| Engine | Needs | Searches |
| --- | --- | --- |
| `tgrep` (default) | [microsoft/tgrep](https://github.com/microsoft/tgrep) 1.2.6 or newer on `PATH` (or `SMALL_CHANGE_TGREP`) | an index built over a checkout |
| `git-grep` (the fallback of `auto`) | git | the tracked files of the commit, read from git's object store; no checkout of files |
| `graft` | the `@nanonets/graft` npm package on `PATH` (or `SMALL_CHANGE_GRAFT`) | a symbol graph built with tree-sitter; adds `callers` and `skeleton` |

Measured on one machine with tgrep 1.0.8 (the tgrep rows were not redone with 1.2.6; one query and the
index were spot-checked: an index of 0.3 s and 11 to 15 ms for the query), on a checkout of about 4,700 tracked files (TypeScript, Kotlin, Swift,
C++), cloned from a local path so that no network time is in it. Times are per request.

| | checkout | setup | `grep` | `file` | `callers` / `skeleton` |
| --- | --- | --- | --- | --- | --- |
| `git-grep` | 0.6 s | none | 65 to 115 ms | 26 ms | not offered |
| `tgrep` | 1.1 s | 0.3 s (index) | 7 to 25 ms | 24 ms | not offered |
| `graft` | 1.0 s | 10 s (cold build) | 930 to 1060 ms | 27 ms | 250 ms / 230 ms |

A fetch from Bitbucket added a few seconds to every engine (6 to 16 s for the checkout in the runs
below, most of which ran four at a time). A model run is minutes, so none of these times decides the
choice at this repository size. `tgrep` may matter on a much larger repository; that was not
measured.

What the engines return for the same request:

- `git-grep` and `tgrep` returned the same hits (path and line) on all four `grep` queries tried
  (4, 24, 15 and 857 hits; checked again with 1.2.6). `tgrep` needs its index built with
  `--hidden --no-ignore`: by default it leaves out dot files such as `.eslintrc.js` and every file
  that `.gitignore` matches, even a file that is tracked (a force-added `dist/` file or
  `.env.local`; in a test repository it found 2 of 5 such files until the flags were added). A
  search that misses a file answers "not found", which the agent reads as proof, so this tool builds
  the index with both flags and a test covers it. A search then passes `--hidden` and nothing else,
  because the index holds dot files but a search leaves them out unless asked. In 1.2.6 that
  query uses the index (0.03 s for 857 hits, against 0.35 s with `--no-ignore` and 0.75 s with both
  flags, which make tgrep scan the tree). In 1.0.8 `--hidden` at query time made tgrep scan the tree,
  about 30 times slower. Its search behaved differently enough that versions before 1.2.6 are
  refused; the versions in between were not tried.
- `graft` returned the same hits on the three queries that matched TypeScript, TSX and Kotlin
  files, and capped one query at 300 hits where git found 857. In `.swift` files it matched two
  words in full and missed a third entirely; why was not investigated. **It returned no hit in files it
  does not parse**: `.gradle`, `.xml`, `.json`, `.yml`, `.plist`, `.pbxproj`, `.sh`, `.m`/`.mm`, lock
  files and files without an extension, where `git-grep` and `tgrep` found them (for example 0 hits
  of a pipeline step name in the pipelines YAML file, where git grep found 6). A review that needs
  to look at build or manifest files gets nothing from `graft grep`. It is the only engine with
  `callers` and `skeleton`.
- `graft` is a third-party package that sends anonymous usage events unless told not to, and has
  an install script. This tool runs it with `DO_NOT_TRACK=1` and a scratch `HOME`; that it honors
  the variable was read in its source, not observed on the network. In these tests it ran under a
  profile that denies all network access.

What the lookups changed in the review, on one pull request that touches TypeScript, Kotlin and
Swift files (3 runs per engine; the reviewer Muse `muse-spark-1.3` at budget `large`, the verifier
Claude `opus` at `medium`):

| | final P1 or P2 per run | P1/P2 lowered by the verifier | requests per run | total time per run |
| --- | --- | --- | --- | --- |
| `off` | 0, 0, 1 | 3 | 0 | 1.8 to 7.7 min |
| `git-grep` | 0, 1, 0 | 2 | 8 to 14 | 5.8 to 8.7 min |
| `tgrep` | 0, 0, 0 | 7 | 6 to 8 | 2.8 to 7.8 min |
| `graft` | 0, 0, 0 | 3 | 8 to 13 | 6.8 to 8.2 min |

(Most runs ran four at a time, so the model's own latency, which varies a lot between runs, is
mixed into the times.)

Read it for what it is: three runs per engine do not separate the engines. A P1 or P2 survived in
one run of `off` and one of `git-grep` and in none of `tgrep` and `graft`, which is within the noise
between two runs of the same setup. What the runs do show is the mechanism. In two of the three
`git-grep` runs the reviewer raised a P1 that a Kotlin library module imports a class of the app
module, which would not build. The verifier searched the repository, found three existing files of
the same library module with the same import, quoted one of them, and the finding went down to P3.
Without lookups the verifier has only the diff and cannot quote a file the PR does not touch. In
those runs the reviewer itself did not search for that import; the verifier did. On a second PR
that has no findings with `off`, none of the four engines produced a P1 or P2 (`git-grep` added one
question).

Because the verifier, not the reviewer, was the one that searched for the counter-example, the
reviewer's prompt now says to spend its lookups on refuting its own P1 and P2 candidates first (the
same pattern already used in files the PR does not touch; who writes, resets or calls the thing it
says nobody handles), and on its last turn to drop or lower a candidate that a result refutes. The
verifier's prompt is unchanged. Three runs on the same PR with the default engine, against the six
`tgrep` and `git-grep` runs above: 4 P1/P2 candidates reached the verifier (1.3 per run) against 10
(1.7 per run), the verifier refuted 3 of 4 against 9 of 10, and one P1/P2 remained in each set. The
reviewer's lookups looked as before (still 6 to 8 per run, mostly the same searches), and the
Kotlin import finding did not come up in these three runs, so whether the reviewer now searches for
it was not tested. **No effect can be told from this sample.** The instruction stays because it
costs a few lines of prompt and the cause it addresses was seen; keep or drop it on more runs.

## Choices to check

The rules leave room for interpretation. These are the choices made here; each is easy to change.

- **A service is a directory.** The first `--service-depth` directories of a path (default 2, so
  `services/payments`). A file at the repository root belongs to the service `.`, which counts as
  one.
- **The limits are "fewer than N".** That means `count < N`. Read literally with N = 1, a frontend
  PR would pass only when it touches no service, and an 8-line change to one file failed. So
  `--kind frontend` uses N = 2: one affected service is allowed. `--kind backend` keeps N = 3, so
  two are. `--max-services <n>` sets N directly.
- **Author history is per service.** The author's merged PRs are read newest first, one by one, and
  a PR counts for every affected service it touches. It stops when each service has enough, or after
  `--history-limit` PRs (default 100), in which case the check fails. The PRs are read one at a time,
  at about a second each, so 100 PRs take a couple of minutes.
- **`--search` is on by default, with tgrep.** It costs a shallow clone of the PR's commit over the
  network (6 to 16 s here) and a second model run for each agent that asks for lookups; if the clone
  fails the review goes on without them. `--search off` turns it off. `tgrep` was chosen over
  `git-grep` for its speed (7 to 26 ms against 62 to 110 ms per request, measured with 1.0.8), not for better results:
  both returned the same hits on every query tried. It is an extra program to install, which is why
  `auto` falls back to `git grep`. `graft` is the one to choose only for `callers` and `skeleton`,
  knowing that its `grep` does not see config and build files.
- **Only unresolved findings count.** Without `--bot`, a comment from anyone that matches the
  pattern is a finding; `--bot` narrows that to the named review bots (name, nickname or UUID).
- **A renamed file counts on both sides**: its old and new path are both checked against the
  exclusions and both name a service.
- **Files that Bitbucket leaves out of a diff** by its own exclusion patterns (lock files, by
  default) count as zero lines.

## Not covered

- Bitbucket Data Center. Only `https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>` URLs.
- Acting on the verdict: the tool reports, and the pipeline decides what to do with the exit code.
- Whether a PR from a fork can be read has not been verified.

## Development

```sh
npm test            # node --test, running the TypeScript sources directly
npm run typecheck
npm run build
```

The workflow diagram is PlantUML. After changing `docs/workflow.puml`, render it again with
`plantuml -tpng docs/workflow.puml` (Graphviz is required).

No runtime dependencies. The checks are pure functions over data (`src/checks.ts`); `src/bitbucket.ts`
is the only module that talks to Bitbucket, and `src/llm/` is the only one that starts the agent
CLIs.

## License

MIT
