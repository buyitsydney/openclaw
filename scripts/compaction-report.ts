#!/usr/bin/env bun
/**
 * CLI tool to view compaction reports.
 *
 * Usage:
 *   bun scripts/compaction-report.ts                              # latest report
 *   bun scripts/compaction-report.ts --all                        # list all reports
 *   bun scripts/compaction-report.ts --session <path.jsonl>       # build from session file
 *   bun scripts/compaction-report.ts --session <path.jsonl> --all # all compactions in session
 */

import { existsSync } from "node:fs";

// Resolve the extension module — works both locally (bun) and inside Docker (node dist/).
const reportModule = await import("../extensions/feishu-her/src/compaction-report.js");

const {
  readLatestReport,
  listReportFiles,
  getReportsDir,
  parseSessionJsonl,
  buildReport,
  buildAllReports,
  formatMarkdown,
  formatSummaryList,
} = reportModule;

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const sessionIdx = args.indexOf("--session");
const sessionFile = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;

if (sessionFile) {
  if (!existsSync(sessionFile)) {
    console.error(`Session file not found: ${sessionFile}`);
    process.exit(1);
  }
  const entries = parseSessionJsonl(sessionFile);
  if (showAll) {
    const reports = buildAllReports(entries, sessionFile);
    if (reports.length === 0) {
      console.log("No compaction entries found in session file.");
    } else {
      console.log(formatSummaryList(reports));
      console.log("\n---\n");
      for (const r of reports) {
        console.log(formatMarkdown(r));
        console.log("\n---\n");
      }
    }
  } else {
    const report = buildReport(entries, sessionFile);
    if (!report) {
      console.log("No compaction entries found in session file.");
    } else {
      console.log(formatMarkdown(report));
    }
  }
} else if (showAll) {
  const files = listReportFiles();
  if (files.length === 0) {
    console.log("No compaction reports found.");
    console.log(`Reports directory: ${getReportsDir()}`);
  } else {
    console.log(`Compaction Reports (${files.length} files)\n`);
    console.log(`Directory: ${getReportsDir()}\n`);
    for (const f of files) {
      console.log(`  ${f}`);
    }
  }
} else {
  const content = readLatestReport();
  if (!content) {
    console.log("No compaction reports found.");
    console.log(`Reports directory: ${getReportsDir()}`);
    console.log(
      "\nTrigger a compaction to generate a report, or use --session <path.jsonl> to analyze a session file.",
    );
  } else {
    console.log(content);
  }
}
