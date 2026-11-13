#!/bin/sh
set -eu
cd /app/llbot

if [ -n "${PROTOCOL_MODE:-}" ] && [ "$PROTOCOL_MODE" != "pmhq" ]; then
  echo "This self-hosted build requires external PMHQ; PROTOCOL_MODE must be pmhq or omitted" >&2
  exit 1
fi

# Modify JSON structurally; reject invalid configuration rather than corrupting it with sed.
node --input-type=module -e '
import fs from "node:fs";
const config = JSON.parse(fs.readFileSync("default_config.json", "utf8"));
const port = process.env.WEBUI_PORT ?? "3080";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid WEBUI_PORT");
config.webui.port = Number(port);
config.webui.host = process.env.WEBUI_HOST ?? "0.0.0.0";
config.ffmpeg = "/usr/bin/ffmpeg";
fs.writeFileSync("default_config.json", JSON.stringify(config, null, 2));
'

mkdir -p data
set -- --pmhq-host="${PMHQ_HOST:-pmhq}" --pmhq-port="${PMHQ_PORT:-13000}" "$@"
case "${PMHQ_LEGACY:-false}" in
  true|1) set -- "$@" --pmhq-legacy ;;
  false|0) ;;
  *) echo "PMHQ_LEGACY must be true/false or 1/0" >&2; exit 1 ;;
esac
# QQ account/session management belongs to the external backend, not platform token files.
exec node --enable-source-maps ./llbot.js "$@"
