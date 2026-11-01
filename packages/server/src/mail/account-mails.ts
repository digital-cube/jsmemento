import type { FastifyBaseLogger } from "fastify";
import type { UserRow } from "../db/schema.js";
import type { Mailer } from "./mailer.js";
import type { MailTemplates } from "./templates.js";

/** The account mails (verify, reset) with their links into the service site. */
export class AccountMails {
  constructor(
    private readonly options: {
      mailer: Mailer;
      templates: MailTemplates;
      /** Public origin of the service site, no trailing slash. */
      serviceUrl: string;
      log: Pick<FastifyBaseLogger, "error">;
    },
  ) {}

  /** `${serviceUrl}/verify/<token>`, valid 24 h. */
  verify(user: UserRow, token: string): Promise<void> {
    return this.send(user, "verify", `/verify/${token}`);
  }

  /** `${serviceUrl}/reset/<token>`, valid 1 h. */
  reset(user: UserRow, token: string): Promise<void> {
    return this.send(user, "reset", `/reset/${token}`);
  }

  private async send(user: UserRow, kind: string, path: string): Promise<void> {
    const { serviceUrl, templates, mailer, log } = this.options;
    try {
      const mail = templates.render(kind, user.locale, {
        name: user.name,
        link: `${serviceUrl}${path}`,
        service_url: serviceUrl,
      });
      await mailer.send({ to: user.email, ...mail });
    } catch (error) {
      log.error({ err: error, kind, user: user.id }, "could not send an account mail");
    }
  }
}
