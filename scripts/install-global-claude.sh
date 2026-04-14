#!/bin/bash
# Usage:
#   install-global-claude.sh [--dry-run] [--force] [--quiet]
#
# Idempotent installer for ~/.claude/ global configuration.
# Reads templates from $(dirname "$0")/../global-claude-template/ and
# merges/installs them into ~/.claude/ following the rules defined in
# the bootstrap plan (encapsulated-yawning-music.md).
#
# Flags:
#   --dry-run   Print what would be done; make zero changes.
#   --force     Overwrite skip-if-exists files (CLAUDE.md, role-vocabulary.md,
#               role-etiquette.md, roles/*/_index.md, role-framework-spec.md).
#   --quiet     Suppress informational output; only print warnings/errors.
#
# Idempotency guarantee: re-running on an already-configured machine
# should make zero changes, create zero backups, and exit 0.

set -euo pipefail

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
DRY_RUN=false
FORCE=false
QUIET=false
CHANGES=0
WARNINGS=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --force)   FORCE=true ;;
    --quiet)   QUIET=true ;;
    --help)
      sed -n '/^# Usage:/,/^[^#]/p' "$0" | head -n 20
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_DIR="$(cd "$SCRIPT_DIR/../global-claude-template" && pwd)"
CLAUDE_DIR="$HOME/.claude"
BACKUP_BASE="$CLAUDE_DIR/backups"
TIMESTAMP="$(date +%Y-%m-%dT%H%M%S)"
BACKUP_DIR="$BACKUP_BASE/$TIMESTAMP"
BACKUP_CREATED=false

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info() {
  "$QUIET" || echo "  $*"
}

warn() {
  echo "  [WARN] $*" >&2
  WARNINGS=$((WARNINGS + 1))
}

# Ensure backup directory exists (created on first use)
ensure_backup_dir() {
  if [ "$BACKUP_CREATED" = false ] && [ "$DRY_RUN" = false ]; then
    mkdir -p "$BACKUP_DIR"
    BACKUP_CREATED=true
  fi
}

# Back up a file to the backup dir (preserving relative path from CLAUDE_DIR)
backup_file() {
  local file="$1"
  if [ ! -f "$file" ]; then return; fi
  if [ "$DRY_RUN" = true ]; then return; fi
  ensure_backup_dir
  local rel="${file#$CLAUDE_DIR/}"
  local dest="$BACKUP_DIR/$rel"
  mkdir -p "$(dirname "$dest")"
  cp "$file" "$dest"
}

# Install a file: copy src -> dst (backs up dst first if it exists).
do_install() {
  local src="$1"
  local dst="$2"
  local label="${dst#$CLAUDE_DIR/}"
  if [ "$DRY_RUN" = true ]; then
    info "[dry-run] would install: $label"
    CHANGES=$((CHANGES + 1))
    return
  fi
  backup_file "$dst"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  info "installed: $label"
  CHANGES=$((CHANGES + 1))
}

# Install only if the destination does not already exist (skip-if-exists).
install_if_missing() {
  local src="$1"
  local dst="$2"
  local label="${dst#$CLAUDE_DIR/}"
  if [ -f "$dst" ] && [ "$FORCE" = false ]; then
    info "skip (exists): $label"
    return
  fi
  do_install "$src" "$dst"
}

# Install hooks: compare content hash; overwrite+backup if different.
install_hook() {
  local src="$1"
  local dst="$2"
  local label="${dst#$CLAUDE_DIR/}"
  if [ ! -f "$dst" ]; then
    do_install "$src" "$dst"
    if [ "$DRY_RUN" = false ]; then
      chmod +x "$dst"
    fi
    return
  fi
  local src_hash dst_hash
  src_hash="$(shasum -a 256 "$src" | awk '{print $1}')"
  dst_hash="$(shasum -a 256 "$dst" | awk '{print $1}')"
  if [ "$src_hash" = "$dst_hash" ]; then
    info "skip (unchanged): $label"
    return
  fi
  info "updating hook (content changed): $label"
  do_install "$src" "$dst"
  if [ "$DRY_RUN" = false ]; then
    chmod +x "$dst"
  fi
}

# ---------------------------------------------------------------------------
# Step 1: Markdown files (skip-if-exists, unless --force)
# ---------------------------------------------------------------------------
install_markdown_files() {
  info ""
  info "--- Markdown files (skip-if-exists) ---"
  install_if_missing "$TEMPLATE_DIR/CLAUDE.md"           "$CLAUDE_DIR/CLAUDE.md"
  install_if_missing "$TEMPLATE_DIR/role-vocabulary.md"  "$CLAUDE_DIR/role-vocabulary.md"
  install_if_missing "$TEMPLATE_DIR/role-etiquette.md"   "$CLAUDE_DIR/role-etiquette.md"
}

# ---------------------------------------------------------------------------
# Step 2: settings.json — deep merge (baseline as fallback, user values win)
# ---------------------------------------------------------------------------
install_settings() {
  info ""
  info "--- settings.json (deep merge) ---"
  local settings="$CLAUDE_DIR/settings.json"
  local baseline="$TEMPLATE_DIR/settings.baseline.json"

  if [ ! -f "$settings" ]; then
    # No existing settings: strip the _comment key and install
    info "installing fresh settings.json (no existing file)"
    if [ "$DRY_RUN" = false ]; then
      mkdir -p "$CLAUDE_DIR"
      jq 'del(._comment)' "$baseline" > "$settings"
      CHANGES=$((CHANGES + 1))
    else
      info "[dry-run] would install fresh settings.json"
      CHANGES=$((CHANGES + 1))
    fi
    return
  fi

  # Compute what merged would look like
  local merged
  merged="$(jq -s '
    .[0] as $user |
    .[1] as $baseline |

    # Deep-merge: user values win at all scalar/object levels.
    # For hooks arrays, concatenate and deduplicate by content.
    # For permissions.allow and additionalDirectories, union+dedup.

    def merge_obj(a; b):
      (a // {}) * (b // {}) |
      if (a | type) == "object" and (b | type) == "object"
      then
        [(a | keys), (b | keys)] | add | unique |
        map(. as $k | {($k): (merge_obj(a[$k]; b[$k]))}) |
        add
      else a
      end;

    $user |

    # Ensure permissions exists
    .permissions = (.permissions // {}) |

    # Union-merge permissions.allow (deduplicated)
    .permissions.allow = (
      ((.permissions.allow // []) + ($baseline.permissions.allow // [])) | unique
    ) |

    # Union-merge additionalDirectories (deduplicated)
    .permissions.additionalDirectories = (
      ((.permissions.additionalDirectories // []) +
       ($baseline.permissions.additionalDirectories // [])) | unique
    ) |

    # Merge hooks: for each hook event, concatenate arrays deduplicated by "command"
    .hooks = (
      (.hooks // {}) as $uh |
      ($baseline.hooks // {}) as $bh |
      [$uh, $bh] |
      map(keys) | add | unique |
      map(. as $event | {
        ($event): (
          (($uh[$event] // []) + ($bh[$event] // [])) |
          unique_by(.hooks[0].command? // .)
        )
      }) | add // {}
    ) |

    # Scalar fallbacks from baseline (only if not set in user config)
    .effortLevel          = (.effortLevel          // $baseline.effortLevel) |
    .autoMemoryEnabled    = (.autoMemoryEnabled    // $baseline.autoMemoryEnabled) |
    .autoDreamEnabled     = (.autoDreamEnabled     // $baseline.autoDreamEnabled)
  ' "$settings" "$baseline")"

  # Check if anything actually changed
  local current_hash merged_hash
  current_hash="$(echo "$(cat "$settings")" | jq -cS . | shasum -a 256 | awk '{print $1}')"
  merged_hash="$(echo "$merged" | jq -cS . | shasum -a 256 | awk '{print $1}')"

  if [ "$current_hash" = "$merged_hash" ]; then
    info "skip (no changes needed): settings.json"
    return
  fi

  info "merging new baseline keys into settings.json"
  if [ "$DRY_RUN" = false ]; then
    backup_file "$settings"
    echo "$merged" > "$settings"
    CHANGES=$((CHANGES + 1))
  else
    info "[dry-run] would merge settings.json"
    CHANGES=$((CHANGES + 1))
  fi
}

# ---------------------------------------------------------------------------
# Step 3: Hooks (content-hash compare; overwrite if changed)
# ---------------------------------------------------------------------------
install_hooks() {
  info ""
  info "--- Hooks (overwrite if changed) ---"
  mkdir -p "$CLAUDE_DIR/hooks"
  install_hook "$TEMPLATE_DIR/hooks/role-wakeup.sh"         "$CLAUDE_DIR/hooks/role-wakeup.sh"
  install_hook "$TEMPLATE_DIR/hooks/worktree-discipline.sh" "$CLAUDE_DIR/hooks/worktree-discipline.sh"
}

# ---------------------------------------------------------------------------
# Step 4: Roles (skip-if-exists; never create decision-log.md)
# ---------------------------------------------------------------------------
install_roles() {
  info ""
  info "--- Roles (skip-if-exists) ---"

  # architect
  local arch_dir="$CLAUDE_DIR/roles/architect"
  mkdir -p "$arch_dir"
  install_if_missing "$TEMPLATE_DIR/roles/architect/_index.md"            "$arch_dir/_index.md"
  install_if_missing "$TEMPLATE_DIR/roles/architect/role-framework-spec.md" "$arch_dir/role-framework-spec.md"

  # broker-maintainer
  local bm_dir="$CLAUDE_DIR/roles/broker-maintainer"
  mkdir -p "$bm_dir"
  install_if_missing "$TEMPLATE_DIR/roles/broker-maintainer/_index.md"    "$bm_dir/_index.md"
}

# ---------------------------------------------------------------------------
# Step 5: Skills (skip-if-exists; warn if differs)
# ---------------------------------------------------------------------------
install_skills() {
  info ""
  info "--- Skills ---"
  local skill_dir="$CLAUDE_DIR/skills/vault-init"
  local skill_dst="$skill_dir/SKILL.md"
  local skill_src="$TEMPLATE_DIR/skills/vault-init/SKILL.md"

  if [ ! -f "$skill_dst" ]; then
    mkdir -p "$skill_dir"
    do_install "$skill_src" "$skill_dst"
    return
  fi

  # Skill exists: warn if it differs from template (could be outdated)
  local src_hash dst_hash
  src_hash="$(shasum -a 256 "$skill_src" | awk '{print $1}')"
  dst_hash="$(shasum -a 256 "$skill_dst" | awk '{print $1}')"
  if [ "$src_hash" != "$dst_hash" ]; then
    warn "skills/vault-init/SKILL.md exists but differs from template."
    warn "  To update: cp $skill_src $skill_dst"
    warn "  Or re-run with --force to overwrite."
    if [ "$FORCE" = true ]; then
      do_install "$skill_src" "$skill_dst"
    fi
  else
    info "skip (unchanged): skills/vault-init/SKILL.md"
  fi
}

# ---------------------------------------------------------------------------
# Step 6: vault-template migration
# ---------------------------------------------------------------------------
migrate_vault_template() {
  local old_tmpl="$HOME/.claude/vault-template"
  local new_tmpl="${CLAUDE_PEERS_MCP_PATH:-$HOME/claude-peers-mcp}/vault-template"

  info ""
  info "--- vault-template migration ---"

  if [ ! -d "$old_tmpl" ]; then
    info "skip: ~/.claude/vault-template/ does not exist (already migrated or never present)"
    return
  fi

  if [ ! -d "$new_tmpl" ]; then
    warn "~/.claude/vault-template/ exists but $new_tmpl does not."
    warn "Cannot migrate. Clone claude-peers-mcp first, then re-run."
    return
  fi

  # Compare the two directories
  local diff_output
  diff_output="$(diff -rq --exclude='.DS_Store' "$old_tmpl" "$new_tmpl" 2>&1 || true)"

  if [ -n "$diff_output" ]; then
    warn "~/.claude/vault-template/ exists but differs from $new_tmpl:"
    warn "$diff_output"
    warn "Not removing. Resolve differences manually, then re-run."
    return
  fi

  # Directories match — safe to remove
  info "~/.claude/vault-template/ matches repo copy; removing old location"
  if [ "$DRY_RUN" = false ]; then
    ensure_backup_dir
    cp -R "$old_tmpl" "$BACKUP_DIR/vault-template"
    rm -rf "$old_tmpl"
    CHANGES=$((CHANGES + 1))
  else
    info "[dry-run] would remove ~/.claude/vault-template/ (backed up first)"
    CHANGES=$((CHANGES + 1))
  fi
}

# ---------------------------------------------------------------------------
# Step 7: Shell rc wrappers (.zshrc migration to sourced ~/.claude-peers-rc.sh)
# ---------------------------------------------------------------------------
install_shell_wrappers() {
  info ""
  info "--- Shell rc wrappers ---"

  local rc_file="${BOOTSTRAP_RC_FILE:-}"
  if [ -z "$rc_file" ]; then
    case "${SHELL:-}" in
      */zsh)  rc_file="$HOME/.zshrc" ;;
      */bash) rc_file="$HOME/.bashrc" ;;
      *)      rc_file="$HOME/.zshrc" ;;
    esac
  fi

  local peers_rc="$HOME/.claude-peers-rc.sh"
  local marker_start="# BEGIN claude-peers"
  local marker_end="# END claude-peers"
  local source_line="[ -f \"\$HOME/.claude-peers-rc.sh\" ] && source \"\$HOME/.claude-peers-rc.sh\""

  # Case A: source line already present → fully installed, check rc file is current
  if [ -f "$rc_file" ] && grep -qF "$source_line" "$rc_file" 2>/dev/null; then
    # Check if the rc file itself is current
    if [ -f "$peers_rc" ]; then
      local src_hash dst_hash
      src_hash="$(shasum -a 256 "$TEMPLATE_DIR/zshrc-wrappers.sh" | awk '{print $1}')"
      dst_hash="$(shasum -a 256 "$peers_rc" | awk '{print $1}')"
      if [ "$src_hash" != "$dst_hash" ]; then
        info "updating ~/.claude-peers-rc.sh (template changed)"
        if [ "$DRY_RUN" = false ]; then
          cp "$TEMPLATE_DIR/zshrc-wrappers.sh" "$peers_rc"
          CHANGES=$((CHANGES + 1))
        else
          info "[dry-run] would update ~/.claude-peers-rc.sh"
          CHANGES=$((CHANGES + 1))
        fi
      else
        info "skip (unchanged): ~/.claude-peers-rc.sh and $rc_file source line"
      fi
    else
      # source line in rc but rc file missing — install it
      info "installing missing ~/.claude-peers-rc.sh"
      if [ "$DRY_RUN" = false ]; then
        cp "$TEMPLATE_DIR/zshrc-wrappers.sh" "$peers_rc"
        CHANGES=$((CHANGES + 1))
      else
        info "[dry-run] would install ~/.claude-peers-rc.sh"
        CHANGES=$((CHANGES + 1))
      fi
    fi
    return
  fi

  # Case B: inline claudepeers-* functions exist without markers
  if [ -f "$rc_file" ] && grep -qE '^claudepeers(-[a-z-]+)?\(\)' "$rc_file" 2>/dev/null; then
    # Migrate: extract inline functions, replace with source line between markers
    info "migrating inline claudepeers-* functions in $rc_file → ~/.claude-peers-rc.sh"
    if [ "$DRY_RUN" = false ]; then
      # 1. Back up .zshrc
      backup_file "$rc_file"
      # 2. Install ~/.claude-peers-rc.sh
      cp "$TEMPLATE_DIR/zshrc-wrappers.sh" "$peers_rc"
      # 3. Remove inline function blocks from .zshrc
      #    Strategy: remove lines between "claudepeers-FOO() {" and matching "}"
      #    Also remove "alias claudepeers=..." lines
      local tmp
      tmp="$(mktemp)"
      # Use Python for reliable multi-line function removal (bash awk gets messy)
      python3 - "$rc_file" > "$tmp" <<'PYEOF'
import sys, re

with open(sys.argv[1]) as f:
    content = f.read()

# Remove alias claudepeers=... line
content = re.sub(r'^alias claudepeers=.*\n', '', content, flags=re.MULTILINE)

# Remove claudepeers-* function blocks (function + body up to matching closing brace)
# Handles both 'funcname() {' and 'funcname () {' forms
content = re.sub(
    r'^claudepeers(-[\w-]+)?\s*\(\)\s*\{[^}]*(?:\n[^}]*)*\}\n?',
    '',
    content,
    flags=re.MULTILINE
)

# Clean up any triple+ blank lines left behind
content = re.sub(r'\n{3,}', '\n\n', content)

print(content, end='')
PYEOF
      # 4. Append marker block
      printf '\n%s\n%s\n%s\n' "$marker_start" "$source_line" "$marker_end" >> "$tmp"
      mv "$tmp" "$rc_file"
      CHANGES=$((CHANGES + 1))
      info "wrappers moved to ~/.claude-peers-rc.sh"
      info "Run: source $rc_file"
    else
      info "[dry-run] would migrate inline functions from $rc_file to ~/.claude-peers-rc.sh"
      CHANGES=$((CHANGES + 1))
    fi
    return
  fi

  # Case C: no wrappers at all — fresh install
  info "installing shell wrappers (fresh)"
  if [ "$DRY_RUN" = false ]; then
    cp "$TEMPLATE_DIR/zshrc-wrappers.sh" "$peers_rc"
    # Create rc_file if it doesn't exist yet
    touch "$rc_file"
    printf '\n%s\n%s\n%s\n' "$marker_start" "$source_line" "$marker_end" >> "$rc_file"
    CHANGES=$((CHANGES + 1))
    info "Run: source $rc_file"
  else
    info "[dry-run] would install ~/.claude-peers-rc.sh and append source line to $rc_file"
    CHANGES=$((CHANGES + 1))
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  "$QUIET" || echo ""
  "$QUIET" || echo "install-global-claude.sh"
  "$QUIET" || echo "  template: $TEMPLATE_DIR"
  "$QUIET" || echo "  target:   $CLAUDE_DIR"
  if "$DRY_RUN"; then
    "$QUIET" || echo "  mode:     DRY RUN (no changes will be made)"
  fi
  "$QUIET" || echo ""

  # Check jq is available (hard requirement per architect constraint)
  if ! command -v jq &>/dev/null; then
    echo "ERROR: jq is required but not found." >&2
    echo "  Install: brew install jq   (macOS)" >&2
    echo "           apt-get install jq (Debian/Ubuntu)" >&2
    exit 1
  fi

  # Check python3 for shell wrapper migration
  if ! command -v python3 &>/dev/null; then
    warn "python3 not found — inline .zshrc function migration will be skipped"
  fi

  install_markdown_files
  install_settings
  install_hooks
  install_roles
  install_skills
  migrate_vault_template
  install_shell_wrappers

  echo ""
  if [ "$CHANGES" -eq 0 ]; then
    echo "Everything already set up. 0 changes."
  else
    if "$DRY_RUN"; then
      echo "Dry run complete. $CHANGES change(s) would be made."
    else
      echo "Done. $CHANGES change(s) made."
      if "$BACKUP_CREATED"; then
        echo "Backup: $BACKUP_DIR"
        echo "  diff -r $BACKUP_DIR ~/.claude/   # to review changes"
      fi
    fi
  fi

  if [ "$WARNINGS" -gt 0 ]; then
    echo "$WARNINGS warning(s) — see output above."
  fi
  echo ""
}

main
