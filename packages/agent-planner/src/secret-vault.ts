/**
 * Best-effort local redaction for credential-shaped text in a free-form goal (e.g.
 * "login with my username of a@b.com and password hunter2").
 *
 * Spec section 11: "Raw neural data remains local by default. Cloud services receive
 * only allowlisted semantic intent ... and the minimum page context required for
 * planning." A password typed as part of a goal is exactly the kind of thing that must
 * never reach a cloud LLM call or an on-disk audit trail - so `redactSecrets` strips it
 * out before the goal text is sent anywhere, and `SecretVault` is the only place the
 * real value is held (in-process, never serialized), until the browser-executor needs
 * it at the moment a field is actually filled.
 *
 * This is deliberately narrow: a regex over common "password ..." phrasings, not a
 * general secret scanner. It only recognizes the "password"/"pwd"/"passcode" family of
 * keywords, not e.g. arbitrary API keys embedded in a sentence. Treat it as a safety
 * net for the common case, not a guarantee - callers should still avoid putting real
 * secrets in free-text commands where possible (a local password-manager/autofill
 * integration would be the correct long-term replacement; see docs/architecture.md).
 */

const SECRET_KEYWORD_PATTERN =
  /\b(?:password|passcode|pwd|passphrase)\b(?:\s+(?:is|of|=|:))?\s*[:=]?\s*(\S+)/gi;

export interface RedactionResult {
  /** The input text with each recognized secret value replaced by a placeholder token. */
  sanitized: string;
  /** placeholder -> real value. Never log, transmit, or persist this map. */
  secrets: Map<string, string>;
}

/** Replaces recognized secret values in `text` with `{{SECRET_n}}` placeholders. */
export function redactSecrets(text: string): RedactionResult {
  const secrets = new Map<string, string>();
  let counter = 0;

  const sanitized = text.replace(SECRET_KEYWORD_PATTERN, (match, value: string) => {
    counter += 1;
    const placeholder = `{{SECRET_${counter}}}`;
    secrets.set(placeholder, value);
    return match.slice(0, match.length - value.length) + placeholder;
  });

  return { sanitized, secrets };
}

/**
 * Holds real secret values keyed by the placeholder a planner put in a plan's action
 * params, and substitutes them back in immediately before the browser-executor uses
 * them. Never expose the resolved (real) value to anything that logs or transmits it -
 * see `Orchestrator.runPlan`, which resolves only for the live `executor.execute()`
 * call and keeps the placeholder version for the audit log and feedback UI.
 */
export class SecretVault {
  private readonly store = new Map<string, string>();

  put(secrets: Map<string, string>): void {
    for (const [placeholder, value] of secrets) {
      this.store.set(placeholder, value);
    }
  }

  get size(): number {
    return this.store.size;
  }

  /** Returns a copy of `params` with any placeholder-bearing string values resolved. */
  resolve(params: Record<string, unknown>): Record<string, unknown> {
    if (this.store.size === 0) return params;
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      resolved[key] = typeof value === "string" ? this.resolveString(value) : value;
    }
    return resolved;
  }

  private resolveString(value: string): string {
    let result = value;
    for (const [placeholder, real] of this.store) {
      if (result.includes(placeholder)) {
        result = result.split(placeholder).join(real);
      }
    }
    return result;
  }
}
