// Copy only named settings, never the caller's Git state (including config injection).
export function childEnv(extra = {}, pass = []) {
  const env = Object.assign(Object.create(null), extra);
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'TMPDIR', ...pass]) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/^(GIT_|BENCH_)/.test(key) && !(key in env)
      && key !== 'PI_MODEL' && key !== 'PI_THINKING' && process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
