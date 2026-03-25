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

# ---- TLA+ setup -------------------------------------------------------------

TLA_VENDOR_DIR="${SCRIPT_DIR}/vendor"
TLA_JAR="${TLA_VENDOR_DIR}/tla2tools.jar"
TLA_VERSION="1.8.0"
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar"

tla_setup() {
    echo "Setting up TLA+ toolchain..."

    if ! command -v java &>/dev/null; then
        echo "Error: Java is required for TLA+ verification. Install JDK 11+ first." >&2
        exit 1
    fi

    mkdir -p "${TLA_VENDOR_DIR}"

    if [ -f "${TLA_JAR}" ]; then
        echo "tla2tools.jar already present at ${TLA_JAR}"
    else
        echo "Downloading tla2tools.jar v${TLA_VERSION}..."
        curl -fSL -o "${TLA_JAR}" "${TLA_URL}" || {
            echo "Error: failed to download tla2tools.jar from ${TLA_URL}" >&2
            echo "You can download it manually from https://github.com/tlaplus/tlaplus/releases" >&2
            exit 1
        }
        echo "Downloaded tla2tools.jar to ${TLA_JAR}"
    fi

    echo "Verifying SANY..."
    java -cp "${TLA_JAR}" tla2sany.SANY 2>&1 | head -3 || true
    echo ""
    echo "TLA+ toolchain ready."
}

# ---- meta-cognition gateway -------------------------------------------------

META_DIR="${SCRIPT_DIR}/meta_cognition"
META_VENV="${META_DIR}/.venv"
META_PORT="${META_GATEWAY_PORT:-8200}"
META_HEALTH="http://localhost:${META_PORT}/health"

meta_setup() {
    echo "Setting up meta-cognition gateway..."

    if ! command -v python3 &>/dev/null; then
        echo "Error: python3 is required for the meta-cognition gateway." >&2
        echo "Install Python 3.10+ and try again." >&2
        exit 1
    fi

    if [ ! -d "${META_VENV}" ]; then
        echo "Creating virtual environment at ${META_VENV}..."
        python3 -m venv "${META_VENV}"
    fi

    echo "Installing dependencies..."
    "${META_VENV}/bin/pip" install -q -r "${META_DIR}/requirements.txt"

    echo ""
    echo "Meta-cognition gateway ready."
    echo "Start with: ./mermaid.sh meta-start"
}

meta_start() {
    if [ ! -d "${META_VENV}" ]; then
        echo "Meta gateway not set up. Run: ./mermaid.sh meta-setup" >&2
        exit 1
    fi

    echo "Starting meta-cognition gateway on port ${META_PORT}..."
    META_GATEWAY_PORT="${META_PORT}" "${META_VENV}/bin/python" -m uvicorn \
        meta_cognition.gateway:app \
        --host 0.0.0.0 \
        --port "${META_PORT}" \
        --app-dir "${SCRIPT_DIR}" &
    META_PID=$!

    sleep 2
    if curl -sf "${META_HEALTH}" >/dev/null 2>&1; then
        echo "Meta-cognition gateway running (PID ${META_PID})"
    else
        echo "Warning: meta gateway may not have started. Check logs." >&2
    fi
}

meta_cron() {
    if ! curl -sf "${META_HEALTH}" >/dev/null 2>&1; then
        echo "Meta gateway not running. Start with: ./mermaid.sh meta-start" >&2
        exit 1
    fi

    echo "Running meta-cognition CRON optimization..."
    curl -s -X POST "http://localhost:${META_PORT}/cron/optimize" | python3 -m json.tool
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
    tla-setup)
        tla_setup
        ;;
    meta-setup)
        meta_setup
        ;;
    meta-start)
        meta_start
        ;;
    meta-cron)
        meta_cron
        ;;
    *)
        echo "Usage:"
        echo "  ./mermaid.sh start              Start the app server"
        echo "  ./mermaid.sh compile            Compile all archs/*.mmd"
        echo "  ./mermaid.sh compile <file.mmd> Compile a specific file"
        echo "  ./mermaid.sh test               Run the test suite"
        echo "  ./mermaid.sh validate           Validate all .mmd files against axiom rules"
        echo "  ./mermaid.sh tla-setup          Download TLA+ tools (tla2tools.jar)"
        echo "  ./mermaid.sh meta-setup         Set up meta-cognition gateway (Python venv + deps)"
        echo "  ./mermaid.sh meta-start         Start meta-cognition gateway (port ${META_PORT})"
        echo "  ./mermaid.sh meta-cron          Run meta-cognition CRON optimization manually"
        exit 0
        ;;
esac
