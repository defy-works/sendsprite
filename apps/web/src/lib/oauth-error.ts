/** better-auth OAuth callback error codes worth a human sentence. */
export function describeOAuthError(code: string | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case "access_denied":
      return "You cancelled the sign-in with the provider.";
    case "email_not_found":
      return "The provider did not share an email address. Add a verified email to that account and try again.";
    case "signup_disabled":
      return "Sign-ups are closed on this instance.";
    case "account_already_linked_to_different_user":
      return "That provider account is already linked to a different user.";
    default:
      return `Sign-in failed (${code.replace(/_/g, " ")}). Please try again.`;
  }
}
