#!/bin/sh

set -e

PLUGIN_NAME="siyuan-agent"
PLUGIN_DIR="/Users/azusa/SiYuan/data/plugins/${PLUGIN_NAME}"

npm run build

mkdir -p "${PLUGIN_DIR}/i18n"

cp dist/index.js   "${PLUGIN_DIR}/"
cp dist/index.css  "${PLUGIN_DIR}/"
cp dist/plugin.json "${PLUGIN_DIR}/"
cp dist/icon.png   "${PLUGIN_DIR}/"
cp dist/preview.png "${PLUGIN_DIR}/"
cp dist/README*.md "${PLUGIN_DIR}/"
cp dist/i18n/*     "${PLUGIN_DIR}/i18n/"

echo "Deployed ${PLUGIN_NAME} to ${PLUGIN_DIR}"
