/**
 * Run one command and print its resource usage as JSON on stderr's last line. Runs in its own
 * process so that the children rusage it reads belongs to that single command.
 */
const r = Bun.spawnSync(process.argv.slice(2), { stdout: 'ignore', stderr: 'pipe' });
const u = r.resourceUsage;
process.stderr.write(r.stderr);
process.stderr.write(
  `\n@@RUSAGE ${JSON.stringify({ exitCode: r.exitCode, signal: r.signalCode ?? null, cpu: Number(u.cpuTime.total) / 1e6, maxRssKb: u.maxRSS })}\n`,
);
