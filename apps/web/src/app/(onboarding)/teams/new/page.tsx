import { requireSession } from "@/lib/session";
import { CreateTeamForm } from "./CreateTeamForm";

export const metadata = { title: "Create team" };

export default async function NewTeamPage() {
  await requireSession();
  return (
    <main className="grid-hairlines flex min-h-dvh items-center justify-center p-6">
      <div className="glass-strong w-full max-w-sm p-8">
        <p className="num-stamp">New team</p>
        <CreateTeamForm />
      </div>
    </main>
  );
}
