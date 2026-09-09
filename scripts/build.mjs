#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pug from "pug";
import stylus from "stylus";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "src");
const dist = resolve(root, "dist");
const pages = [
  ["travel.pug", "index.html", "./", "assets/travel.js", { type: "travel" }],
  ["travel_detail.pug", "continents/index.html", "../", "assets/travel.js", { type: "travel_detail", detail: "continents", title: "大洲" }],
  ["travel_detail.pug", "countries/index.html", "../", "assets/travel.js", { type: "travel_detail", detail: "countries", title: "国家/地区" }],
  ["travel_detail.pug", "cities/index.html", "../", "assets/travel.js", { type: "travel_detail", detail: "cities", title: "城市" }],
  ["travel_detail.pug", "airports/index.html", "../", "assets/travel.js", { type: "travel_detail", detail: "airports", title: "机场" }],
  ["travel_detail.pug", "routes/index.html", "../", "assets/travel.js", { type: "travel_detail", detail: "routes", title: "航线" }],
  ["travel_report.pug", "report/2025/index.html", "../../", "assets/travel-report.js", { type: "travel_report", reportYear: "2025" }],
];

const site = {
  data: {
    travel: JSON.parse(await readFile(resolve(src, "data/travel.json"), "utf8")),
    travel_map_labels: JSON.parse(await readFile(resolve(src, "data/travel_map_labels.json"), "utf8")),
  },
};

function renderCss(source) {
  return new Promise((resolveCss, reject) => {
    stylus(source).set("filename", resolve(src, "styles/travel.styl")).render((error, css) => error ? reject(error) : resolveCss(css));
  });
}

function rewriteFragment(fragment) {
  return fragment
    .replace(/<script defer data-pjax src="(?:\/)?js\/travel(?:-report)?\.js[^>]*><\/script>/g, "")
    .replaceAll('href="/travel/', 'href="')
    .replaceAll('src="/img/', 'src="img/')
    .replaceAll('href="/img/', 'href="img/');
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(src, "assets/img"), resolve(dist, "img"), { recursive: true });
await cp(resolve(src, "assets/icons"), resolve(dist, "icons"), { recursive: true });
await mkdir(resolve(dist, "assets"), { recursive: true });

const stylusSource = `${await readFile(resolve(src, "styles/function.styl"), "utf8")}\n${await readFile(resolve(src, "styles/travel.styl"), "utf8")}`;
const css = `${await readFile(resolve(src, "styles/base.css"), "utf8")}\n${await renderCss(stylusSource)}`;
await writeFile(resolve(dist, "assets/travel.css"), css, "utf8");

for (const scriptName of ["travel.js", "travel-report.js"]) {
  const script = (await readFile(resolve(src, `assets/${scriptName}`), "utf8"))
    .replaceAll('"/img/travel/', '"img/travel/')
    .replaceAll("'/travel/", "'")
    .replaceAll('"/travel/', '"');
  await writeFile(resolve(dist, `assets/${scriptName}`), script, "utf8");
}

for (const [templateFile, outputFile, baseHref, scriptFile, pageMeta] of pages) {
  const templatePath = resolve(src, "templates/page", templateFile);
  const render = pug.compileFile(templatePath, { basedir: resolve(src, "templates/page") });
  const fragment = rewriteFragment(render({ site, page: pageMeta, url_for: (path) => path }));
  const title = outputFile.startsWith("report/") ? "年度飞行报告 · Travel Footprint" : "Travel Footprint";
  const documentHtml = `<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <base href="${baseHref}">\n  <title>${title}</title>\n  <link rel="icon" type="image/svg+xml" href="icons/favicon-plane.svg">\n  <link rel="stylesheet" href="assets/travel.css">\n</head>\n<body>\n  <header class="site-header"><a href="">Travel Footprint</a></header>\n  <main class="layout">${fragment}</main>\n  <footer class="site-footer">Travel Footprint</footer>\n  <script defer src="${scriptFile}"></script>\n</body>\n</html>\n`;
  const destination = resolve(dist, outputFile);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, documentHtml, "utf8");
}

await writeFile(resolve(dist, ".nojekyll"), "", "utf8");
console.log("Built standalone site in dist/");
