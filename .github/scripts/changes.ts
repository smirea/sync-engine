import { $ } from "bun";
import { appendFileSync } from "node:fs";
import { extname } from "node:path";
import { env } from "node:process";

const { BASE_SHA: base, HEAD_SHA: head, EVENT_NAME: event, GITHUB_OUTPUT: output } = env;
if (!head || !event || !output) throw new Error("Missing change detection environment");

const full = event === "workflow_dispatch" || !base || /^0+$/.test(base);
const comparison = event === "pull_request" ? `${base}...${head}` : `${base}..${head}`;
const paths = (
  full ? [] : (await $`git diff --name-only -z ${comparison}`.text()).split("\0")
).filter(
  (name) =>
    name && ![".md", ".rst"].includes(extname(name).toLowerCase()) && !name.startsWith("docs/"),
);
const common = full || paths.some((name) => name.startsWith(".github/"));
const isSwift = (name: string) =>
  name === "Package.swift" || name.startsWith("Sources/") || name.startsWith("Tests/");
const swift = common || paths.some(isSwift);
const spec = common || paths.some((name) => name.startsWith("spec/") || name === "scripts/spec.ts");
// The browser suite runs nowhere else, so every package it loads reruns it.
const web =
  common ||
  paths.some((name) => /^packages\/(client-web|client|core|bun-sqlite|bun-server)\//.test(name));

appendFileSync(output, `swift=${swift}\nspec=${spec}\nweb=${web}\n`);
