import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { env } from "@/env";
import { loadEnv } from "@/env.schema";
import { isInstanceAdmin, parseAdminEmails } from "@/lib/instance-admin";
import { requireSession } from "@/lib/session";
import { ProfileForm } from "./ProfileForm";
import { PasswordForm } from "./PasswordForm";
import { SessionsPanel } from "./SessionsPanel";

export const metadata = { title: "Account" };

/**
 * The account page.
 *
 * There was none. The only thing the corner of the header offered was "Sign
 * out", so a display name set at signup could never be corrected, a password
 * could never be changed from inside the product, and a session left open on
 * a machine somebody no longer has could not be closed. Those three are the
 * floor for an account surface, and they are what this is.
 *
 * Deliberately separate from team settings: this is the person, that is the
 * organisation, and merging them is how somebody renames a team while trying
 * to rename themselves.
 */
export default async function AccountPage() {
  const s = await requireSession();
  const admin = isInstanceAdmin(
    {
      email: s.user.email,
      flag: (s.user as { instanceAdmin?: boolean }).instanceAdmin === true,
    },
    parseAdminEmails(loadEnv().INSTANCE_ADMIN_EMAILS),
  );

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <PageHeader
        title="Account"
        description="You, rather than any one team. Changes here follow you into every team you belong to."
      />

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          {admin && <Badge variant="indigo">Instance admin</Badge>}
        </CardHeader>
        <CardBody>
          <ProfileForm
            name={s.user.name ?? ""}
            email={s.user.email}
            createdAt={new Intl.DateTimeFormat("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            }).format(s.user.createdAt)}
          />
        </CardBody>
      </Card>

      {/* No password to change on an instance that only offers OAuth. */}
      {env.providers.emailPassword && (
        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
          </CardHeader>
          <CardBody>
            <PasswordForm />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
        </CardHeader>
        <CardBody>
          <SessionsPanel currentToken={s.session.token} />
        </CardBody>
      </Card>
    </div>
  );
}
