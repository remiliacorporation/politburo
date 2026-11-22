# Sprite behaviour: cloud setup script v10 (WP-105)

Source: `pi-router/cloud-setup-script-v10.sh` (109 lines, 31455 bytes, md5 `85ae4a3c39fdb1f3032e9feb5b311d6f`, matches the README) and `pi-router/README.md`. Nothing was run or installed. No network except `git fetch origin` for the router comparison.

No secret, token, auth file content or API key was found in the script. Credentials are only ever read from environment variables at run time (names listed below). Value status for every one of them: not present in the script.

## 0. Setup script layout (in order)

1. Line 2: install `bun` if missing (downloads the installer with curl).
2. Line 3: install `pi` if missing: `npm install -g @earendil-works/pi-coding-agent@1.4.0`.
3. Line 4: `pi install npm:@ifi/pi-provider-cursor@0.5.1`, output discarded, failure ignored.
4. Line 5: `D` is the directory of the `pi` binary. All five helpers are written into `$D` with mode 755.
5. Lines 6-20: `pi-auth-ensure`. Lines 21-44: `pi-task`. Lines 45-55: `sprite-start`. Lines 56-88: `sprite-watch`. Lines 89-96: `sprite-stop`.
6. Lines 98-101: replace the `pi` binary with a wrapper script.
7. Line 102: append an auth-ensure line to `~/.bashrc` and `~/.profile`.
8. Lines 103-104: create `~/.pi/agent/extensions`, write the router (base64 gzip blob).
9. Line 105: Cursor provider patch (blob), conditional on a checksum.
10. Line 106: write `~/.pi/agent/models-store.json` only if missing or empty (blob).
11. Line 107: write `~/.pi/agent/auth.json` from env (setup time).
12. Line 108: `true`. Line 109: settings step.

Every helper is written with `cat > "$D/<name>" <<'TOOLEOF' && chmod 755 "$D/<name>"`. Quoted heredoc, so no expansion at write time.

## 1. Helpers

### 1.1 pi-auth-ensure

Verbatim (script lines 6-20; the inner text is lines 7-19):

```sh
#!/bin/sh
[ -n "$PI_CODEX_AUTH$PI_CURSOR$PI_CODEX_PERSONAL_AUTH" ] || exit 0
node -e '
const fs=require("fs"),path=require("path"),p=path.join(require("os").homedir(),".pi/agent/auth.json");
let cur={};try{cur=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}
if(!cur||typeof cur!=="object"||Array.isArray(cur))cur={};
let changed=false;
for(const v of ["PI_CODEX_AUTH","PI_CURSOR","PI_CODEX_PERSONAL_AUTH"]){const s=process.env[v];if(!s)continue;let o;try{o=JSON.parse(Buffer.from(s,"base64").toString())}catch{continue}
 if(v==="PI_CODEX_PERSONAL_AUTH"&&o&&o["openai-codex"]&&!o["openai-codex-personal"]){o={"openai-codex-personal":o["openai-codex"]}}
 for(const k of Object.keys(o)){const c=cur[k],n=o[k];const stale=c&&typeof c==="object"&&n&&typeof n.expires==="number"&&!(typeof c.expires==="number"&&c.expires>=n.expires);if(!c||typeof c!=="object"||!Object.keys(c).length||stale){cur[k]=n;changed=true}}}
if(changed){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p+".tmp",JSON.stringify(cur),{mode:0o600});fs.renameSync(p+".tmp",p)}
try{fs.chmodSync(p,0o600)}catch{}' >/dev/null 2>&1
exit 0
```

- Arguments: none.
- Exit codes: always 0. No path exits non-zero. The node call output and errors go to `/dev/null`.
- Env read: `PI_CODEX_AUTH`, `PI_CURSOR`, `PI_CODEX_PERSONAL_AUTH`. Env set: none.
- Files: reads and writes `~/.pi/agent/auth.json`. Writes `~/.pi/agent/auth.json.tmp` then renames it over the target. Mode 600 on the temp file; `chmod 600` on the target afterwards (errors ignored). Creates `~/.pi/agent` if missing.
- Behaviour:
  - If all three variables are empty, it exits at once and touches nothing.
  - Each variable holds base64 of a JSON object keyed by provider name. A variable that is not valid base64 JSON is skipped silently.
  - For `PI_CODEX_PERSONAL_AUTH` only: if the object has an `openai-codex` key and no `openai-codex-personal` key, the object is replaced by `{"openai-codex-personal": <that value>}`.
  - For each provider key, the existing entry in auth.json is replaced when it is missing, not an object, an empty object, or stale. Stale means: the new entry has a numeric `expires` and the current entry does not have a numeric `expires` that is greater than or equal to it.
  - It never deletes a key. The file is rewritten only when something changed.
  - A non-object or array auth.json is treated as `{}`.
- Constants: none.

### 1.2 pi-task

Verbatim (script lines 21-44; inner text lines 22-43):

```bash
#!/bin/bash
set -u
if [ $# -lt 1 ] || [ ! -s "$1" ]; then echo "usage: pi-task <task-file> [max-seconds]" >&2; exit 2; fi
task=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); max=${2:-2400}; idle=${PI_IDLE_SECONDS:-180}
log=${PI_TASK_LOG:-/tmp/pi-task-$(date +%s).jsonl}
fingerprint() { printf '%s %s' "$(wc -c < "$log")" "$({ git diff; git ls-files -o --exclude-standard; } 2>/dev/null | cksum)"; }
pi-auth-ensure 2>/dev/null; setsid pi -p --mode json ${PI_SESSION_DIR:+--session-dir "$PI_SESSION_DIR"} --model "${PI_MODEL:-fallback/codex-cursor}" --thinking "${PI_THINKING:-medium}" -- "$(cat "$task")" </dev/null >"$log" 2>"$log.err" &
pid=$!; echo "$pid" > "$log.pid"; start=$(date +%s); last=$start; prev=""; why=""
echo "pi-task: pid $pid, log $log, idle limit ${idle}s, max ${max}s" >&2
while kill -0 "$pid" 2>/dev/null; do
  sleep 5; now=$(date +%s); cur=$(fingerprint)
  if [ "$cur" != "$prev" ]; then prev=$cur; last=$now; fi
  if [ $((now-last)) -ge "$idle" ]; then why="idle: no output and no file change for ${idle}s"; rc=125
  elif [ $((now-start)) -ge "$max" ]; then why="timeout after ${max}s"; rc=124; fi
  if [ -n "$why" ]; then kill -TERM -- "-$pid" 2>/dev/null; sleep 5; kill -KILL -- "-$pid" 2>/dev/null; break; fi
done
if [ -z "$why" ]; then wait "$pid"; rc=$?; else { wait "$pid"; } 2>/dev/null; fi
echo "pi-task: rc=$rc secs=$(( $(date +%s)-start ))${why:+ ($why)}"
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n");let t="",m="";for(const x of l){try{const e=JSON.parse(x);if(e.type==="message_end"&&e.message&&e.message.role==="assistant"){m=e.message.provider?e.message.provider+"/"+e.message.model:m;t=(e.message.content||[]).filter(c=>c.type==="text").map(c=>c.text).join("\n")||t}}catch{}}console.log("pi-task: model "+(m||"none"));console.log(t||"(no reply)")' "$log"
git diff --stat 2>/dev/null | tail -n 1
[ "$rc" -ne 0 ] && tail -n 5 "$log.err" >&2
exit "$rc"
```

- Usage: `pi-task <task-file> [max-seconds]`. Run it inside the git work tree to watch.
- Exit codes:
  - 2: no argument, or the task file is missing or empty. Usage line on stderr.
  - 125: idle rule fired (see constants). Process group killed.
  - 124: total time limit fired. Process group killed.
  - Anything else: the exit status of `pi` itself (`wait`). 0 on success.
  - If both limits are reached in the same check, idle wins (checked first).
  - If the script is killed by `set -u` on an unset variable, status is non-zero from bash; no such path was found.
- Env read: `PI_IDLE_SECONDS` (default 180), `PI_TASK_LOG` (default `/tmp/pi-task-<epoch-seconds>.jsonl`), `PI_SESSION_DIR` (optional), `PI_MODEL` (default `fallback/codex-cursor`), `PI_THINKING` (default `medium`). It also passes the full environment to `pi-auth-ensure` and `pi`, so `PI_CODEX_AUTH`, `PI_CURSOR`, `PI_CODEX_PERSONAL_AUTH` are used indirectly. Env set: none.
- Files:
  - Reads the task file (full text becomes the prompt, passed after `--`).
  - Writes `$log` (pi stdout, JSON lines), `$log.err` (pi stderr), `$log.pid` (pid of the `setsid pi` process).
  - Runs `git diff`, `git ls-files -o --exclude-standard`, `git diff --stat` in the current directory.
  - `pi-auth-ensure` may rewrite `~/.pi/agent/auth.json`.
- Constants:
  - Default max 2400 s (second argument).
  - Idle rule: default 180 s. The fingerprint is the log byte size plus the checksum of `git diff` output and the list of untracked, non-ignored file names. If the fingerprint has not changed for 180 s, the task is killed with 125.
  - Poll interval: 5 s. First check happens after 5 s.
  - Kill: TERM to the process group (`-$pid`), wait 5 s, then KILL.
  - Prompt mode: `pi -p --mode json`, stdin from `/dev/null`.
- Output:
  - stderr, at start: `pi-task: pid <pid>, log <log>, idle limit <idle>s, max <max>s`.
  - stdout, at end: `pi-task: rc=<rc> secs=<n>` plus ` (<why>)` when a limit fired.
  - Then `pi-task: model <provider>/<model>` (the last assistant message that has a provider; `none` if none), then the text of the last assistant message that has text (`(no reply)` if none). Unparseable lines are skipped.
  - Then the last line of `git diff --stat` (the totals line), nothing if no diff.
  - If rc is not 0: last 5 lines of `$log.err` on stderr.

### 1.3 sprite-start

Verbatim (script lines 45-55; inner text lines 46-54):

```bash
#!/bin/bash
set -u
if [ $# -lt 2 ] || [ ! -s "$2" ]; then echo "usage: sprite-start <name> <task-file> [max-seconds]" >&2; exit 2; fi
n=$1; d=/tmp/sprites; mkdir -p "$d/$n"; rm -f "$d/$n.rc" "$d/$n.out" "$d/$n.watch" "$d/$n.jsonl" "$d/$n.jsonl.pid"
PI_TASK_LOG="$d/$n.jsonl" PI_SESSION_DIR="$d/$n" setsid nohup bash -c 'pi-task "$1" "$2" > "$3.out" 2>&1; echo $? > "$3.rc"' _ "$2" "${3:-2400}" "$d/$n" </dev/null >/dev/null 2>&1 &
echo "$!" > "$d/$n.pid"
echo "sprite $n started in $(pwd)"
echo "  live log: $d/$n.jsonl   session: $d/$n/   result: $d/$n.out   exit code: $d/$n.rc"
echo "  watch: sprite-watch $n   stop: sprite-stop $n"
```

- Usage: `sprite-start <name> <task-file> [max-seconds]`.
- Exit codes: 2 for missing arguments or a missing or empty task file. Otherwise 0 (the shell exits after the last echo; the job is detached). It does not check that the job started.
- Env read: none directly. Env set for the child only: `PI_TASK_LOG`, `PI_SESSION_DIR`.
- Files, under `/tmp/sprites`:
  - Creates directory `/tmp/sprites/<name>/` (pi session dir).
  - Deletes first: `<name>.rc`, `<name>.out`, `<name>.watch`, `<name>.jsonl`, `<name>.jsonl.pid`. Does not delete `<name>.pid`, `<name>.jsonl.err`, or the session directory contents.
  - Writes `<name>.pid` (pid of the detached `setsid nohup bash -c` process), `<name>.out` (pi-task stdout and stderr), `<name>.rc` (pi-task exit status, written when pi-task returns), `<name>.jsonl`, `<name>.jsonl.err`, `<name>.jsonl.pid` (via pi-task).
- Constants: default max 2400 s. Name is not validated (no slash or empty check).
- Output (stdout):
  - `sprite <name> started in <cwd>`
  - `  live log: /tmp/sprites/<name>.jsonl   session: /tmp/sprites/<name>/   result: /tmp/sprites/<name>.out   exit code: /tmp/sprites/<name>.rc`
  - `  watch: sprite-watch <name>   stop: sprite-stop <name>`
- The work runs in the caller's current directory, so git diff checks in pi-task refer to that directory.

### 1.4 sprite-watch

Verbatim (script lines 56-88; inner text lines 57-88; line 77 and 78 are as written):

```bash
#!/bin/bash
set -u
n=${1:?usage: sprite-watch <name> [window-seconds]}; win=${2:-540}; idle=${SPRITE_IDLE_SECONDS:-180}
d=/tmp/sprites; log=$d/$n.jsonl; st=$d/$n.watch
[ -f "$d/$n.pid" ] || { echo "no sprite named $n in $d" >&2; exit 2; }
render() { node -e '
const fs=require("fs"),[log,st]=process.argv.slice(1);let off=0;try{off=+fs.readFileSync(st,"utf8")||0}catch{}
let buf;try{buf=fs.readFileSync(log)}catch{process.exit(0)}
const end=buf.lastIndexOf(10)+1;if(end<=off)process.exit(0);
const cut=(s,n)=>{s=String(s??"").replace(/\s+/g," ").trim();return s.length>n?s.slice(0,n)+"...":s};
const t=new Date().toISOString().slice(11,19);const out=[];
for(const line of buf.subarray(off,end).toString().split("\n")){if(!line)continue;let e;try{e=JSON.parse(line)}catch{continue}
 const a=e.assistantMessageEvent||{};
 if(e.type==="session")out.push("session "+e.id);
 else if(a.type==="thinking_end"&&a.content)out.push("THINK "+cut(a.content,600));
 else if(e.type==="tool_execution_start"){const g=e.args||{};out.push("TOOL  "+e.toolName+" "+cut(g.command??g.path??JSON.stringify(g),300)+(e.toolName==="edit"&&g.edits?" ("+g.edits.length+" edits)":""))}
 else if(e.type==="tool_execution_end"){const r=e.result||{};const tx=(r.content||[]).filter(c=>c.type==="text").map(c=>c.text).join(" ");out.push("  "+(e.isError?"ERROR ":"-> ")+cut(tx,240))}
 else if(e.type==="message_end"&&e.message&&e.message.role==="assistant"){const m=e.message,u=m.usage||{};const tx=(m.content||[]).filter(c=>c.type==="text").map(c=>c.text).join(" ");if(tx)out.push("SAY   "+cut(tx,600));if(m.errorMessage)out.push("ERROR "+cut(m.errorMessage,400));out.push("USAGE "+(m.provider||"")+"/"+(m.model||"")+" in="+(u.input||0)+" out="+(u.output||0)+" reasoning="+(u.reasoning||0)+" stop="+(m.stopReason||""))}
 else if(/error|retry|abort/i.test(e.type))out.push("EVENT "+cut(line,400));
 else if(e.type==="agent_end")out.push("END   agent finished");}
fs.writeFileSync(st,String(end));if(out.length)console.log(out.map(x=>t+" "+x).join("\n"));' "$log" "$st"; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
stop=$(( $(date +%s)+win )); lastdiff=""
while :; do
  render
  ds=$(git diff --shortstat 2>/dev/null); [ "$ds" != "$lastdiff" ] && { echo "$(date -u +%H:%M:%S) DIFF $ds"; lastdiff=$ds; }
  if [ -f "$d/$n.rc" ]; then sleep 1; render; echo "== sprite $n done:"; cat "$d/$n.out"; [ "$(cat "$d/$n.rc")" = 0 ] && exit 0 || exit 1; fi
  now=$(date +%s); ref=$log; [ -f "$ref" ] || ref=$d/$n.pid
  if [ $(( now-$(mtime "$ref") )) -ge "$idle" ]; then echo "== sprite $n IDLE: no event for ${idle}s (pi-task kills it after ${PI_IDLE_SECONDS:-180}s with no file change; or run sprite-stop $n)"; exit 3; fi
  [ "$now" -ge "$stop" ] && { echo "== sprite $n still running after ${win}s window; run sprite-watch $n again"; exit 10; }
  sleep 5
done
```

- Usage: `sprite-watch <name> [window-seconds]`. Run in the same directory as the sprite so `git diff --shortstat` matches.
- Exit codes:
  - Non-zero, no usage-file message, when `<name>` is missing: the `${1:?...}` error. On the macOS system bash 3.2 used for checking this was 127 with message `usage: sprite-watch <name> [window-seconds]`; the code differs by bash version (not verified on the cloud image).
  - 2: `/tmp/sprites/<name>.pid` does not exist. Message `no sprite named <name> in /tmp/sprites` on stderr.
  - 0: the `.rc` file exists and contains exactly `0`.
  - 1: the `.rc` file exists and contains anything else (including 124, 125, 137, or empty).
  - 3: idle. The log (or the `.pid` file if the log is missing) has not been modified for `SPRITE_IDLE_SECONDS` seconds.
  - 10: the watch window ended while the sprite is still running.
- Env read: `SPRITE_IDLE_SECONDS` (default 180). `PI_IDLE_SECONDS` is read only to print its value in the IDLE message. Env set: none.
- Files: reads `/tmp/sprites/<name>.jsonl`, `.pid`, `.rc`, `.out`. Writes `/tmp/sprites/<name>.watch` (byte offset already shown, so repeat calls print only new events). Runs `git diff --shortstat`.
- Constants: default window 540 s; idle 180 s; loop sleep 5 s; 1 s sleep after seeing `.rc` before the final render. Truncation lengths: THINK 600, TOOL 300, tool result 240, SAY 600, ERROR 400, EVENT 400 characters (each followed by `...` when cut).
- Loop order each pass: render new log lines, print DIFF line, check `.rc` (finish), check idle (exit 3), check window (exit 10), sleep 5.
- Output lines (each render line prefixed by `HH:MM:SS ` in UTC, taken once per render call):
  - `session <id>`
  - `THINK <text>` (from `assistantMessageEvent.type == thinking_end`)
  - `TOOL  <toolName> <command|path|json args>` plus ` (<n> edits)` for the `edit` tool
  - `  -> <text>` or `  ERROR <text>` for tool results (two leading spaces)
  - `SAY   <text>`, `ERROR <errorMessage>`, `USAGE <provider>/<model> in=<n> out=<n> reasoning=<n> stop=<reason>` per assistant message end
  - `EVENT <raw json>` for any event whose type matches `error|retry|abort` (case-insensitive)
  - `END   agent finished` for `agent_end`
  - `HH:MM:SS DIFF <git diff --shortstat>` printed when the shortstat changes from the last printed value (the initial value is empty, so an empty diff prints nothing first).
  - `== sprite <name> done:` followed by the full `.out` file.
  - `== sprite <name> IDLE: no event for <idle>s (pi-task kills it after <PI_IDLE_SECONDS or 180>s with no file change; or run sprite-stop <name>)`
  - `== sprite <name> still running after <win>s window; run sprite-watch <name> again`
- Only complete lines are rendered (up to the last newline). The first pass prints from offset 0 unless a `.watch` file exists.
- Idle here does not kill anything. It only reports.

### 1.5 sprite-stop

Verbatim (script lines 89-96; inner text lines 91-95 plus the heredoc open on line 90):

```bash
#!/bin/bash
d=/tmp/sprites; n=${1:?usage: sprite-stop <name>}
for f in "$d/$n.jsonl.pid" "$d/$n.pid"; do [ -s "$f" ] && kill -TERM -- "-$(cat "$f")" 2>/dev/null; done
sleep 3
for f in "$d/$n.jsonl.pid" "$d/$n.pid"; do [ -s "$f" ] && kill -KILL -- "-$(cat "$f")" 2>/dev/null; done
[ -f "$d/$n.rc" ] || echo 137 > "$d/$n.rc"; echo "sprite $n stopped"
```

- Usage: `sprite-stop <name>`.
- Exit codes: non-zero when `<name>` is missing (`${1:?...}`; 127 on bash 3.2, version dependent). Otherwise 0, always, even if the sprite does not exist or kills fail (the last command is `echo`). It does not use `set -u`.
- Env read/set: none.
- Files: reads `/tmp/sprites/<name>.jsonl.pid` and `/tmp/sprites/<name>.pid`. Writes `/tmp/sprites/<name>.rc` with `137` only if no `.rc` exists yet.
- Constants: 3 s between TERM and KILL.
- Behaviour: sends TERM to the process group of each pid file (the pi process first, then the detached wrapper), waits 3 s, sends KILL to the same groups, then creates the `.rc` marker if missing, then prints `sprite <name> stopped`. It does not remove any file. Because it writes 137 only when `.rc` is absent, a later `sprite-watch` reports `done` with exit 1.
- Pid reuse is not guarded (stale pid files could point at an unrelated group).

### 1.6 pi wrapper (not one of the five, but installed by the same script)

Script lines 98-101 verbatim:

```bash
P="$(command -v pi)" && C="$(npm root -g)/@earendil-works/pi-coding-agent/dist/bundle/cli.js" && [ -f "$C" ] && rm -f "$P" && { printf '#!/bin/sh\nPI_CLI="%s"\n' "$C"; cat <<'EOF'; } > "$P" && chmod 755 "$P"
"$(dirname "$0")/pi-auth-ensure" 2>/dev/null
exec node "$PI_CLI" "$@"
EOF
```

Effect: the `pi` binary is replaced by a shell script that runs `pi-auth-ensure` (from the same directory) and then `exec node <cli.js> "$@"`. This means every `pi` start, including each pi-task, refreshes auth.json from the environment. If the bundle `cli.js` is not found, `pi` is left unchanged.

Line 102 verbatim (shell startup hook):

```bash
for f in ~/.bashrc ~/.profile; do grep -q pi-auth-ensure "$f" 2>/dev/null || echo 'command -v pi-auth-ensure >/dev/null 2>&1 && pi-auth-ensure >/dev/null 2>&1' >> "$f"; done
```

Line 107 verbatim (setup-time auth write; overwrites the whole file when either variable is set; the personal variable is not used here):

```bash
node -e 'const o={};for(const v of ["PI_CODEX_AUTH","PI_CURSOR"]){const s=process.env[v];if(s)Object.assign(o,JSON.parse(Buffer.from(s,"base64").toString()))}if(Object.keys(o).length)require("fs").writeFileSync(require("os").homedir()+"/.pi/agent/auth.json",JSON.stringify(o),{mode:0o600})' || true
```

Embedded blobs (text elided here, not secret):
- Line 104: router, `echo '<base64 gzip>' | base64 -d | gunzip > ~/.pi/agent/extensions/codex-cursor-fallback.ts`.
- Line 105: Cursor provider patch. Runs only if `find ~/.pi/agent -path "*@ifi/pi-provider-cursor/provider.ts"` finds a file whose md5 is `018877a6b1e7e93d26dab08c02f786e7`. Decodes to 27892 bytes, written to `"$CP.new"` then moved over the file (`|| true`).
- Line 106: `[ -s ~/.pi/agent/models-store.json ] || echo '<blob>' | base64 -d | gunzip > ~/.pi/agent/models-store.json`. Decodes to 8383 bytes of JSON: model catalog entries with `id`, `api`, `provider`, `baseUrl`, costs. No key-like fields found.

## 2. Settings step

Script line 109 verbatim (last line):

```bash
node -e 'const fs=require("fs"),os=require("os"),d=os.homedir()+"/.pi/agent",p=d+"/settings.json";let j={};try{j=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}j.defaultProvider="fallback";j.defaultModel="codex-cursor";fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p,JSON.stringify(j,null,2),{mode:0o600})' || true
```

- Reads `~/.pi/agent/settings.json` if present and valid JSON (unreadable or invalid JSON is treated as `{}`, so the old content is lost in that case).
- Sets `defaultProvider` to `fallback` and `defaultModel` to `codex-cursor`. Other keys are kept.
- Writes with 2-space indent, mode 600 (the mode applies only when the file is created; an existing file keeps its mode).
- Creates `~/.pi/agent` if needed. Failure is ignored (`|| true`). Env read: none (uses `os.homedir()`).
- Purpose (README): bare `pi -p` routes through the router instead of Bedrock.

## 3. Which router copy is live

- Decoded blob: 29733 bytes, md5 `05aab53f1bcf8b83c46a06c51d1ecd59`.
- `git -C <tigeryard> fetch origin` succeeded. `origin/main` is at `ac8e444`. `git show origin/main:tools/pi-router/codex-cursor-fallback.ts` is 29733 bytes, md5 `05aab53f1bcf8b83c46a06c51d1ecd59`.
- Result: identical. `diff` is empty.
- Install path in v10: `~/.pi/agent/extensions/codex-cursor-fallback.ts`.
- Note: the README in the notes folder says the router is from PR 52 head 92ae5429. `origin/main` now has the same bytes, so the PR content is on main. The older standalone copy `pi-router/codex-cursor-fallback.ts` is 7536 bytes and is NOT what v10 installs (not compared further).
- Router environment variable names (read by the router): `PI_FALLBACK_COOLDOWN_MINUTES` (default 30), `PI_FALLBACK_CURSOR_MODEL`, `PI_FALLBACK_PRIMARY_MODEL`, `PI_FALLBACK_STATE_FILE` (default `~/.pi/agent/codex-cursor-cooldown.json`), `PI_FALLBACK_STREAM_IDLE_SECONDS` (default 90). Constants in the file: handoff 120000 ms, lock stale 10000 ms, lock poll 25 ms. The patched Cursor provider reads `PI_CURSOR_DEBUG`.

## 4. Observed behaviour a reimplementation must reproduce

1. All state is under `/tmp/sprites`: `<name>/`, `<name>.pid`, `<name>.jsonl`, `<name>.jsonl.pid`, `<name>.jsonl.err`, `<name>.out`, `<name>.rc`, `<name>.watch`. Exact suffixes matter because the helpers find each other by them.
2. `sprite-start` clears `.rc .out .watch .jsonl .jsonl.pid` before launching. It leaves `.pid`, `.jsonl.err` and the session dir. It prints the three-line banner shown above.
3. The `.rc` file is written only after pi-task returns, by the detached wrapper. Its presence is the "done" signal for `sprite-watch`. `sprite-stop` also writes 137 if absent.
4. `sprite-watch` exit codes: 0 done and ok, 1 done and failed, 2 unknown sprite, 3 idle, 10 window ended. Callers likely loop on 10.
5. Two idle rules with the same default of 180 s but different meaning: pi-task kills the sprite (exit 125, no output growth and no git change for 180 s, polled every 5 s); sprite-watch only reports (exit 3, log file mtime older than 180 s).
6. pi-task fingerprint uses log size plus `git diff` checksum plus untracked file names. Edits to an already untracked file do not count as a change (only names are listed), and the log counts stdout only, not `.err`.
7. Kill order: TERM to the process group, 5 s, KILL. sprite-stop uses 3 s.
8. pi-task result block order: `pi-task: rc=... secs=...`, `pi-task: model ...`, reply text, diff totals line, then on failure the last 5 stderr lines (stderr).
9. `pi-auth-ensure` runs three times per sprite: from pi-task, from the `pi` wrapper, and (interactive shells) from `~/.bashrc` and `~/.profile`. It is idempotent and silent, always exits 0.
10. Order of the setup: bun, pi 1.4.0, Cursor provider 0.5.1, helpers, pi wrapper, shell hooks, router, patch, model catalog, auth file, settings. Settings is last, so `defaultProvider` and `defaultModel` are set even if earlier optional steps failed (they use `|| true`).
11. The pi command line is exactly `pi -p --mode json [--session-dir <dir>] --model <PI_MODEL or fallback/codex-cursor> --thinking <PI_THINKING or medium> -- <task text>`. stdin is `/dev/null`. It starts under `setsid`.
12. Log format is pi JSON lines. The watcher depends on these event names: `session`, `message_end`, `tool_execution_start`, `tool_execution_end`, `agent_end`, plus `assistantMessageEvent.type == thinking_end`.
13. Time stamps in watcher output are UTC.
14. `mtime` tries GNU `stat -c %Y` first, then BSD `stat -f %m`.

## 5. Unknowns

- Whether `setsid` forks in the cloud image, which decides whether `$!` equals the process group id used by `kill -- -$pid`. Not tested (helpers must not be run).
- Whether the detached wrapper `bash -c ... echo $? > .rc` also receives the TERM from `sprite-stop`, and so whether a late write can overwrite the `137` marker. Not tested.
- The exact exit status for a missing `<name>` argument on the cloud image's bash version (127 on bash 3.2 here).
- How pi exits on router or auth failures (exit status other than 0 passes straight through; the set of values was not observed).
- Whether `pi` accepts `--session-dir` and `--thinking` the same way in 1.4.0 as assumed (taken from the script, not checked against the pi package).
- Whether the cloud environment sets `PI_CODEX_AUTH`, `PI_CURSOR`, `PI_CODEX_PERSONAL_AUTH` (names only; values not inspected and never present in the script).
- The `handoff-pi-sprites.md` file referenced by the README was not read (outside the given source).
- Router behaviour was not analysed beyond identity and the env names above.
