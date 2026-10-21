#!/usr/bin/env sh
# Собирает статическое демо интерфейса для GitHub Pages в папку _site
set -eu
out="${1:-_site}"
rm -rf "$out"
mkdir -p "$out"
cp -R public/. "$out/"
cp -R demo/media "$out/media"
cp demo/demo.js "$out/demo.js"
rm -f "$out/sw.js"
# демо-бэкенд подключается перед app.js
sed -i.bak 's#<script src="app.js"></script>#<script src="demo.js"></script>\n  <script src="app.js"></script>#' "$out/index.html"
rm -f "$out/index.html.bak"
touch "$out/.nojekyll"
echo "demo built in $out"
