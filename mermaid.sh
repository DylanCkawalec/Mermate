#!/usr/bin/env bash
# =============================================================================
# mermaid.sh — Single entrypoint for the Mermaid-GPT application.
#
# Usage:
#   ./mermaid.sh start              # start the app (UI + API on port 3333)
#   ./mermaid.sh compile            # compile all archs/*.mmd via Node mmdc
#   ./mermaid.sh compile <file.mmd> # compile a specific .mmd file
#   ./mermaid.sh test               # run the test suite
#   ./mermaid.sh validate           # validate .mmd files against axiom rules
#
# Environment:
#   PORT                       App server port      (default: 3333)
#   MERMAID_ENHANCER_URL       GPT enhancer base URL (default: http://localhost:8100)
#   MERMAID_ENHANCER_START_CMD Shell command to start the enhancer if not running
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHS_DIR="${SCRIPT_DIR}/archs"
FLOWS_DIR="${SCRIPT_DIR}/archs/flows"
APP_PORT="${PORT:-3333}"
ENHANCER_URL="${MERMAID_ENHANCER_URL:-http://localhost:8100}"
ENHANCER_HEALTH="${ENHANCER_URL%/}/health"
ENHANCER_START_CMD="${MERMAID_ENHANCER_START_CMD:-}"

# Use the npm-installed @mermaid-js/mermaid-cli, not the system mmdc
MMDC_BIN="${SCRIPT_DIR}/node_modules/.bin/mmdc"
PUPPETEER_CFG="${SCRIPT_DIR}/puppeteer-config.json"

# ---- helpers ----------------------------------------------------------------

check_deps() {
    if [ ! -x "${MMDC_BIN}" ]; then
        echo "Error: @mermaid-js/mermaid-cli not found. Run: npm install" >&2
        exit 1
    fi
}

compile_one() {
    local input_file="$1"
    local name="${input_file%.*}"
    local name_only
    name_only="$(basename "${name}")"

    mkdir -p "${FLOWS_DIR}"

    echo "Compiling: ${input_file}"

    # SVG: wide viewport for maximum detail, vector output scales infinitely
    "${MMDC_BIN}" \
        --input "${ARCHS_DIR}/${input_file}" \
        --output "${FLOWS_DIR}/${name_only}.svg" \
        --puppeteerConfigFile "${PUPPETEER_CFG}" \
        --width 4096 \
        --height 2160 \
        --quiet

    # PNG: ultra-high-res raster (scale 4 on 3840x2160 = ~15360x8640 effective)
    "${MMDC_BIN}" \
        --input "${ARCHS_DIR}/${input_file}" \
        --output "${FLOWS_DIR}/${name_only}.png" \
        --puppeteerConfigFile "${PUPPETEER_CFG}" \
        --width 3840 \
        --height 2160 \
        --scale 4 \
        --quiet

    echo "  -> ${FLOWS_DIR}/${name_only}.svg"
    echo "  -> ${FLOWS_DIR}/${name_only}.png"
}

compile_targets() {
    check_deps
    if [ $# -eq 0 ]; then
        local found=0
        for f in "${ARCHS_DIR}"/*.mmd; do
            [ -f "$f" ] || continue
            compile_one "$(basename "$f")"
            found=1
        done
        if [ "$found" -eq 0 ]; then
            echo "No .mmd files found in ${ARCHS_DIR}/"
        fi
    else
        local arg filename
        for arg in "$@"; do
            filename="${arg%.mmd}.mmd"
            [[ "$arg" == *.mmd ]] && filename="$arg"
            if [ -f "${ARCHS_DIR}/${filename}" ]; then
                compile_one "${filename}"
            else
                echo "Error: ${ARCHS_DIR}/${filename} not found" >&2
                exit 1
            fi
        done
    fi
    echo ""
    echo "Done. Output in ${FLOWS_DIR}/"
}

check_enhancer() {
    echo ""
    echo "Checking GPT enhancer at ${ENHANCER_HEALTH}..."
    if command -v curl >/dev/null 2>&1 && curl -fsS "${ENHANCER_HEALTH}" >/dev/null 2>&1; then
        echo "  Enhancer: healthy"
        return
    fi

    if [ -n "${ENHANCER_START_CMD}" ]; then
        echo "  Enhancer not running — attempting start..."
        sh -lc "cd \"${SCRIPT_DIR}\" && ${ENHANCER_START_CMD}" >/dev/null 2>&1 &
        sleep 3
        if curl -fsS "${ENHANCER_HEALTH}" >/dev/null 2>&1; then
            echo "  Enhancer: started and healthy"
            return
        fi
        echo "  Enhancer: start command ran but health check failed"
    fi
    echo "  Enhancer: unavailable (app will use local copilot fallback + passthrough mode)"
}

clear_port() {
    local pids=()
    local pid
    local attempts

    while IFS= read -r pid; do
        [ -n "${pid}" ] && pids+=("${pid}")
    done < <(lsof -nP -tiTCP:"${APP_PORT}" -sTCP:LISTEN 2>/dev/null || true)

    if [ "${#pids[@]}" -eq 0 ]; then
        return
    fi

    echo "  Port ${APP_PORT} in use by listener PID(s) ${pids[*]} — stopping it..."
    kill "${pids[@]}" 2>/dev/null || true

    for attempts in {1..10}; do
        if ! lsof -nP -tiTCP:"${APP_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
            return
        fi
        sleep 1
    done

    echo "  Listener still active on port ${APP_PORT} after SIGTERM — forcing stop..."
    kill -9 "${pids[@]}" 2>/dev/null || true

    for attempts in {1..5}; do
        if ! lsof -nP -tiTCP:"${APP_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
            return
        fi
        sleep 1
    done

    echo "Error: could not free port ${APP_PORT}. Stop the listener manually and retry." >&2
    exit 1
}

start_service() {
    check_deps
    clear_port
    check_enhancer

    echo ""
    echo "============================================"
    echo "  Mermaid-GPT starting on port ${APP_PORT}"
    echo "  http://localhost:${APP_PORT}"
    echo "============================================"
    echo ""
    exec npm start
}

run_tests() {
    echo "Running test suite..."
    npm test
}

validate_axioms() {
    echo ""
    echo "Running axiom validation on all .mmd files in archs/..."
    echo ""
    node -e "
      const { validate } = require('./server/services/mermaid-validator');
      const { selectDiagramType } = require('./server/services/diagram-selector');
      const { detect } = require('./server/services/input-detector');
      const fs = require('fs');
      const path = require('path');

      const archsDir = path.join(__dirname, 'archs');
      const files = fs.readdirSync(archsDir).filter(f => f.endsWith('.mmd'));

      if (files.length === 0) {
        console.log('No .mmd files found.');
        process.exit(0);
      }

      let totalErrors = 0;
      let totalWarnings = 0;

      for (const file of files) {
        const src = fs.readFileSync(path.join(archsDir, file), 'utf-8');
        const result = validate(src);
        const detection = detect(src);

        const status = result.valid ? 'PASS' : 'FAIL';
        const errCount = result.errors.length;
        const warnCount = result.warnings.length;
        totalErrors += errCount;
        totalWarnings += warnCount;

        console.log(
          status + '  ' + file +
          '  [' + detection.state + ']' +
          '  nodes=' + (result.stats.nodeCount || 0) +
          '  edges=' + (result.stats.edgeCount || 0) +
          '  nesting=' + (result.stats.maxNesting || 0) +
          '  errors=' + errCount +
          '  warnings=' + warnCount
        );

        for (const e of result.errors) {
          console.log('  ERROR: ' + e.message);
        }
        for (const w of result.warnings) {
          console.log('  WARN:  ' + w.message);
        }
      }

      console.log('');
      console.log('Total: ' + files.length + ' files, ' + totalErrors + ' errors, ' + totalWarnings + ' warnings');
      process.exit(totalErrors > 0 ? 1 : 0);
    "
}

# ---- main -------------------------------------------------------------------

case "${1:-}" in
    start)
        start_service
        ;;
    compile)
        shift
        compile_targets "$@"
        ;;
    test)
        run_tests
        ;;
    validate)
        validate_axioms
        ;;
    *)
        echo "Usage:"
        echo "  ./mermaid.sh start              Start the app server"
        echo "  ./mermaid.sh compile            Compile all archs/*.mmd"
        echo "  ./mermaid.sh compile <file.mmd> Compile a specific file"
        echo "  ./mermaid.sh test               Run the test suite"
        echo "  ./mermaid.sh validate           Validate all .mmd files against axiom rules"
        exit 0
        ;;
esac
