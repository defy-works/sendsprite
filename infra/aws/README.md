# One-click AWS connect (CloudFormation)

`sendsprite-connect.yaml` is the template behind the **One-click** button in the
setup wizard (`/setup`, step "Connect AWS") and the Instance settings tab. The
wizard opens a CloudFormation _quick-create_ link that prefills the template URL,
the stack name, and two parameters: `CallbackUrl` (`<APP_URL>/api/setup/aws/callback`)
and `CallbackToken` (a one-time token). The user reviews the resources in the AWS
console and clicks _Create stack_; nothing is typed by hand.

## What the stack creates

| Resource               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SendspriteUser`       | IAM user `sendsprite-<stack name>` with one inline policy: SES account/identity/configuration-set read+write, `SendEmail`/`SendRawEmail`/`ApplyTrackingConfigurationOverrides`, `PutAccountDetails`; SNS `CreateTopic`/`Subscribe`/`ConfirmSubscription`/`GetTopicAttributes`/`SetTopicAttributes`/`ListSubscriptionsByTopic` scoped to `arn:aws:sns:*:<account>:sendsprite-*` (`ConfirmSubscription` lets the webhook confirm through the SDK with `AuthenticateOnUnsubscribe`); `sns:Unsubscribe`/`GetSubscriptionAttributes` (subscription ARNs are not topic-scoped); `sts:GetCallerIdentity`. |
| `CallbackFunctionRole` | Lambda execution role allowed only `iam:CreateAccessKey`/`DeleteAccessKey`/`ListAccessKeys` on that user.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CallbackFunction`     | Python 3.12 Lambda (inline code) backing the custom resource.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Callback`             | `Custom::SendspriteCallback` — runs the Lambda on Create/Delete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The SNS topic `sendsprite-events`, the configuration set `sendsprite`, and the
event-destination subscription are **not** part of the stack: Sendsprite creates
them itself after any connect path (instance role, one-click, manual keys) using
the permissions above, so all three paths converge on the same state.

### Why `ses:ApplyTrackingConfigurationOverrides` is in there

Every `SendEmail` passes `ConfigurationOverrides.Tracking` with open and click
tracking `DISABLED`. That is not decoration. Sendsprite serves its own open
pixel and click redirect (`lib/tracking.ts`), and SES turns its own engagement
tracking on for any message whose configuration set has an event destination
matching `OPEN` or `CLICK` — which ours does, so that the same SNS topic can
carry every other event type. Without the override SES would rewrite the links
and insert a second pixel, and both would be counted twice.

SES authorises that per-message override as a separate action from `SendEmail`,
so a policy without it fails **every** send, not just tracked ones:

```
AccessDeniedException: User 'arn:aws:iam::<account>:user/sendsprite-<stack>' is
not authorized to perform 'ses:ApplyTrackingConfigurationOverrides'
```

The message is stored on the email row and shown on its page in the dashboard.

## Updating an existing stack

The template changes with the app; a stack created from an older copy keeps the
policy it was created with. To pick up a permission added since (the one above
is the first), re-run the template over the same stack — the IAM user, its
access key and the connection all survive, because only the inline policy
changes and `Custom::SendspriteCallback` is a no-op on Update:

```sh
aws cloudformation update-stack \
  --stack-name <your stack> \
  --template-body file://infra/aws/sendsprite-connect.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters ParameterKey=CallbackUrl,UsePreviousValue=true \
               ParameterKey=CallbackToken,UsePreviousValue=true
```

In the console it is the same thing: **Update** → _Replace existing template_ →
upload the file → keep both parameters → update.

Disconnecting and reconnecting through the wizard also works and is the path to
suggest to a self-hoster, but it issues a new access key and deletes the old
one. Nothing else is lost: the configuration set, SNS topic and verified
identities live outside the stack.

## Callback flow

1. `startQuickCreate` (server action) revokes the owner's pending tokens, issues a
   new `aws_callback` token (single-use, 15 minutes) and builds the quick-create
   URL. It refuses when `APP_URL` is not `https://` — the template's `CallbackUrl`
   parameter only accepts https, because an HTTP→HTTPS redirect would drop the
   POST body.
2. The user creates the stack. On **Create** the Lambda calls
   `iam:CreateAccessKey` for the new user and POSTs
   `{ token, accessKeyId, secretAccessKey, region, accountId }` once to
   `CallbackUrl`. The secret is created inside the Lambda and never appears in
   CloudFormation parameters, resource properties, stack state, or events.
3. `POST /api/setup/aws/callback` consumes the token atomically (one
   `UPDATE … RETURNING`, so a replay gets 4xx), then runs the normal
   connect-with-keys path. A freshly created key can be rejected until IAM
   propagates it, so the STS/SES checks are retried on propagation errors
   (5 attempts × 3 s, ≤ 15 s in total; the Lambda's POST timeout is 45 s and
   its function timeout 60 s, so the rest of the connect fits). The Lambda
   does **not** retry the POST — the token is single-use.
4. Any non-2xx response makes the Lambda delete the key it just created and
   report `FAILED` to CloudFormation with the callback's response body as the
   reason; the failure is also recorded on the token so the wizard's
   `/api/setup/aws/status` poll can show it. A subscribe-only problem (for
   example the SNS endpoint is not reachable yet) is a 200 with a `warning`,
   which the callback route logs; the connection still succeeds.
5. The wizard polls `/api/setup/aws/status` every 3 s until the token is
   consumed, then advances.

`CallbackToken` is deliberately not `NoEcho`: quick-create links ignore `NoEcho`
parameters, so the wizard could not prefill it. The single-use, 15-minute token
is the mitigation.

## Instances behind a proxy or WAF

The callback is a server-to-server POST from a Lambda in the user's account, so
anything that screens traffic on how "browser-like" it looks will block it
before it reaches the instance. The stack then fails with
`callback returned 403: …` and the wizard never advances — the key is deleted,
so a failed run leaves nothing behind, but it cannot succeed until the request
is let through.

Cloudflare's Browser Integrity Check is the case that shows up in practice: it
answers `403` with a plain-text `error code: 1010` body for clients whose
user-agent looks like a library, which is what urllib's default
`Python-urllib/3.12` looks like. The Lambda therefore sends
`Sendsprite-Connect/1.0 (+https://sendsprite.com)` instead, which passes.

That is a courtesy, not a guarantee — a stricter rule (Bot Fight Mode, a managed
WAF ruleset, an IP allowlist) can still reject it, and a proxy is free to
tighten what it accepts at any time. If the callback keeps failing, exempt the
one path rather than loosening the zone:

```
(http.request.uri.path eq "/api/setup/aws/callback")  ->  Skip
```

The endpoint takes a single-use token that expires in 15 minutes and consumes it
atomically, so it is a safe path to exempt.

## Why the template lives on S3

CloudFormation quick-create links only accept `templateURL`s in S3 URL formats;
a raw GitHub URL is rejected. The instance therefore builds the link from
`CFN_TEMPLATE_URL` (validated to be an S3 URL at boot), which defaults to

```
https://sendsprite-cfn.s3.us-east-1.amazonaws.com/latest/sendsprite-connect.yaml
```

## Publishing the template (maintainers)

One-time bucket setup, in the account that owns `sendsprite-cfn`:

```bash
aws s3 mb s3://sendsprite-cfn --region us-east-1
# Allow public reads via a bucket policy (needs Block Public Access off for policies).
aws s3api put-public-access-block --bucket sendsprite-cfn \
  --public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false
aws s3api put-bucket-policy --bucket sendsprite-cfn --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicRead",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::sendsprite-cfn/*"
  }]
}'
```

Publish a version manually (this is what the CI steps do on a tag):

```bash
aws s3 cp infra/aws/sendsprite-connect.yaml s3://sendsprite-cfn/v1.2.3/sendsprite-connect.yaml --acl public-read
aws s3 cp infra/aws/sendsprite-connect.yaml s3://sendsprite-cfn/latest/sendsprite-connect.yaml --acl public-read
```

`--acl public-read` only works when the bucket's Object Ownership setting allows
ACLs (`ObjectWriter` or `BucketOwnerPreferred`); with the bucket policy above the
flag is redundant and can be dropped.

Then uncomment the two `aws s3 cp` steps in the `cfn` job of
`.github/workflows/ci.yml` (they publish `s3://sendsprite-cfn/${GITHUB_REF_NAME}/…`
and `…/latest/…`) and give the job AWS credentials (OIDC role or secrets). The
`cfn-lint` step already runs on every push.

## Self-hosters: use your own copy

If you do not want to trust a template served from our bucket, copy
`sendsprite-connect.yaml` to your own S3 bucket (it does not need to be public if
the account that opens the link can read it) and set

```
CFN_TEMPLATE_URL=https://<your-bucket>.s3.<region>.amazonaws.com/<key>.yaml
```

or skip one-click entirely and paste keys (the **Manual** path) or run on an
instance role.

## Revoking access

Delete the stack (`sendsprite-connect` by default). On **Delete** the Lambda
removes every access key of the user so CloudFormation can delete the user, and
the role and function are deleted with the stack. Nothing else remains in the
account. Sendsprite's own side is cleared with **Disconnect** in Settings →
Instance (it also unsubscribes the SNS endpoint, best effort).

Stack **Update** is a no-op in the Lambda; re-connecting means deleting the
stack and running one-click again.
