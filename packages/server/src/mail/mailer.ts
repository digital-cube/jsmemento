/** One transactional mail. `text` always; `html` when the template has one. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Sends transactional mails (verify, reset, …). Implementations never throw on delivery. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** The part of a pino / Fastify logger the mailers use. */
export interface MailLog {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Logs every mail at info level with its full text: development, tests, no Brevo key. */
export class LogMailer implements Mailer {
  constructor(private readonly log: MailLog) {}

  async send(message: MailMessage): Promise<void> {
    this.log.info(
      { mail: { to: message.to, subject: message.subject, text: message.text } },
      `mail to ${message.to}: ${message.subject}`,
    );
  }
}

/** Keeps every mail in `sent` (tests, embedders that deliver mail themselves). */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  /** The newest mail to `to`, if any. */
  last(to?: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => to === undefined || m.to === to);
  }
}

export const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

export interface BrevoMailerOptions {
  apiKey: string;
  from: { name: string; email: string };
  log: MailLog;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Default 10 000. */
  timeoutMs?: number;
}

/**
 * Brevo transactional mail (`POST /v3/smtp/email`). A refused or failed delivery is logged
 * as an error and swallowed: the request that triggered the mail still succeeds (the user
 * can ask for it again with resend / forgot).
 */
export class BrevoMailer implements Mailer {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: BrevoMailerOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async send(message: MailMessage): Promise<void> {
    const body = {
      sender: this.options.from,
      to: [{ email: message.to }],
      subject: message.subject,
      textContent: message.text,
      ...(message.html ? { htmlContent: message.html } : {}),
    };
    try {
      const response = await this.fetch(BREVO_URL, {
        method: "POST",
        headers: {
          "api-key": this.options.apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        this.options.log.error(
          { status: response.status, detail: detail.slice(0, 500), to: message.to },
          "brevo refused the mail",
        );
      }
    } catch (error) {
      this.options.log.error({ err: error, to: message.to }, "could not send the mail via brevo");
    }
  }
}
