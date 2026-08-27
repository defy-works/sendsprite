# Disconnect tears the stack down; the wizard has an escape hatch

**Date:** 2026-08-27
**Status:** approved. Escape hatch shipped 2026-08-27 (`cancelQuickCreate`);
teardown not yet implemented.

## Problem

Two faults in the one-click AWS connect flow, found while diagnosing bug-016.

**Disconnect leaves live credentials behind, silently.** `disconnectAws`
unsubscribes the SNS endpoint best-effort and deletes the `team_aws` row. The
CloudFormation stack is untouched, so the IAM user and its access key stay in
the customer's account indefinitely. Nothing in the UI says so. The template's
own `Note` output — "Delete this stack to revoke Sendsprite's access" — is the
only place the obligation is stated, and only someone reading CloudFormation
outputs ever sees it.

**The wizard can trap the owner for an hour.** `QuickCreate` disables
`Open AWS console` while `polling`, and polling only stops on connection, a
recorded failure, a vanished token, or a dead network. An owner who opens the
link and never creates the stack sits on "Waiting for CloudFormation…" until
the token expires. That TTL is 60 minutes (`ttlMs: 60 * 60_000`), not the 15
the template's parameter text still claims.

## Decisions

| Question              | Decision                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Teardown              | Sendsprite calls `DeleteStack` itself. Disconnect says so before it happens.                      |
| How it gets the right | A CloudFormation **service role** in the stack — not a wider policy on the connect user.          |
| Connect user gains    | `cloudformation:DeleteStack` + `DescribeStacks`, scoped to its own stack ARN. Nothing else.       |
| Stack identity        | New nullable `team_aws.stack_id`, from `!Ref AWS::StackId` through the callback.                  |
| No stack recorded     | Degrade to an honest warning plus a console deep link. Not optional — every existing row is here. |
| Escape hatch scope    | Cancel is offered only before AWS calls back; hidden once provisioning starts.                    |

## Why a service role rather than a wider user policy

The obvious shape — grant `SendspriteUser` the deletes for every resource in
its own stack — fails, and fails in a way worth writing down because it is not
obvious from the template.

CloudFormation deletes in reverse dependency order. `Callback` carries
`UserName: !Ref SendspriteUser` in its properties, so `SendspriteUser` is
deleted _after_ `Callback`. The Lambda behind `Callback` has exactly one job on
Delete: remove every access key belonging to that user. Meanwhile `DeleteStack`
called without `RoleARN` runs on "a temporary session that's generated from
your user credentials" ([DeleteStack API reference][ds]). Those credentials are
the key the Lambda just deleted. The session dies with roughly half the stack
still standing, and the stack lands in `DELETE_FAILED` — needing exactly the
console visit the feature exists to avoid.

A service role removes the dependency entirely: CloudFormation makes its calls
as the role, so the Lambda deleting the user's keys is irrelevant to it. It
also keeps `iam:DeleteUser` off the connect user, which matters more — the user
is a long-lived credential held by a SaaS, while the role is assumable only by
`cloudformation.amazonaws.com`.

[ds]: https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DeleteStack.html

## Template changes

### New `ServiceRole`

Trusted by `cloudformation.amazonaws.com`. Its policy covers deleting exactly
what this stack creates, each statement ARN-scoped:

- `iam:DeleteUser`, `iam:DeleteUserPolicy`, `iam:ListAccessKeys`,
  `iam:DeleteAccessKey`, `iam:GetUser` on `SendspriteUser`
- `iam:DeleteRole`, `iam:DeleteRolePolicy`, `iam:DetachRolePolicy`,
  `iam:GetRole` on `CallbackFunctionRole` and on itself
- `lambda:DeleteFunction`, `lambda:GetFunction`, `lambda:InvokeFunction` on
  `CallbackFunction` — `InvokeFunction` because CloudFormation invokes the
  custom resource's Delete handler as the caller

**Deletion order.** The service role is itself a stack resource, so every other
resource carries `DependsOn: ServiceRole`. CloudFormation then deletes it last,
after the calls that need it have been made. Deleting a role does not retract
an in-flight operation the way deleting a user's access key does, and by that
point the only step left is CloudFormation recording completion in its own
control plane.

### `SendspriteUser` policy

Gains one statement:

```yaml
- Effect: Allow
  Action:
    - cloudformation:DeleteStack
    - cloudformation:DescribeStacks
  Resource: !Sub "arn:aws:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/${AWS::StackName}/*"
```

`DeleteStack` is called **with** `RoleARN` set to the service role. Note that
CloudFormation also remembers the role a stack was last associated with, so a
bare `DeleteStack` from the console inherits it too.

### `Callback` custom resource

`StackId: !Ref AWS::StackId` and `ServiceRoleArn: !GetAtt ServiceRole.Arn` join
the properties; the Lambda forwards both in its POST payload alongside the
existing key, region and account id.

### Corrections while here

The `CallbackToken` parameter description and the comment above it both say the
token expires in 15 minutes. It is 60. Fix both strings.

## Data model

`team_aws` gains two nullable columns (migration 0027):

- `stack_id` — full stack ARN, or null for manual keys and every pre-existing
  connection
- `stack_service_role_arn` — the role to pass as `RoleARN`, null likewise

Both nullable and both read together: teardown is attempted only when
`stack_id` is present. Storing the role ARN rather than deriving it means a
future template can move the role without stranding old rows.

## Disconnect flow

`disconnectAws(teamId, actor)` returns a discriminated result so the UI can say
what actually happened, rather than the current bare `Result`:

```ts
type DisconnectOutcome =
  | { kind: "stack_deleting"; stackName: string; consoleUrl: string }
  | {
      kind: "stack_orphaned";
      reason: "no_stack" | "access_denied" | "error";
      consoleUrl: string | null;
      userName: string | null;
    };
```

Order of operations, and the reason for it:

1. Unsubscribe SNS (best-effort, as today) — **before** the stack goes, while
   the credentials still work.
2. If `stack_id` is set, `DeleteStack` with `RoleARN`. Success is
   `stack_deleting`. `AccessDenied` — a stack created before this change —
   falls to `stack_orphaned` with `reason: "access_denied"`.
3. Delete the `team_aws` row. This happens last but **unconditionally**: a
   failed teardown must not leave the team connected to credentials the owner
   has asked to revoke.

Completion is never awaited. The Lambda deletes the access key early in the
teardown, so any poll we ran would fail on its second call and tell us nothing.
The UI links to the stack in the console and says that is where it finishes.

### What survives

SES identities, the configuration set and the SNS topic are created by the app,
not the stack, and are untouched. Reconnecting does not mean re-verifying
domains. The confirm copy should say so — otherwise disconnect reads as more
destructive than it is and nobody will press it.

### UI

The confirm dialog states the consequence before the action, not after: the
stack is deleted, and with it the IAM user and its access key; domains stay
verified. On `stack_orphaned` the result is a persistent warning, not a toast —
it carries an obligation the owner has to act on, with the console link.

## Escape hatch

`cancelQuickCreate` — a server action wrapping the existing
`revokePendingSetupTokens("aws_callback", userId, teamId)`, which is already
what `startQuickCreate` calls to clear a previous attempt.

In `QuickCreate`, a `Cancel` button renders only while
`polling && !provisioning`. It stops the poll and re-enables
`Open AWS console`. Its copy warns that a stack already creating will have its
callback refused and will roll itself back — which is the self-healing path,
and is what the existing `EXPIRED` notice already describes.

Once `inFlight` is true the button is gone. That phase is under a minute, and
cancelling mid-way is what strands a half-created config set and topic.

## Testing

- **Unit** — the disconnect outcome mapping: stack present, absent,
  `AccessDenied`, generic error. Console URL construction from a stack ARN.
- **Integration** — `disconnectAws` deletes the row on every path including a
  thrown `DeleteStack`; `DeleteStack` is called with `RoleARN`; SNS unsubscribe
  precedes it; `cancelQuickCreate` revokes only the caller's team's tokens.
- **Template** — `cfn-lint` clean. Assert in a unit test that every resource
  other than `ServiceRole` carries `DependsOn: ServiceRole`, since the deletion
  order is load-bearing and nothing else would catch its removal.
- **E2E** — cancel returns the wizard to its idle state and `Open AWS console`
  is usable again.

## Migration

Existing connections have no `stack_id` and land on the `stack_orphaned` path
by construction. That is correct rather than a gap: their stacks genuinely
predate the service role and genuinely cannot be deleted by the app. Reconnect
is what moves a team onto the new path, and the fixed template must be
published to `s3://sendsprite-cfn/latest/` before it is worth telling anyone
to.
