# Amazon Bedrock

Bedrock has no bearer API key. Instead, Gini signs every [Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html)
request with **AWS SigV4** using an AWS access key + secret that **you enter when
adding the provider**. Gini stores them in `~/.gini/secrets.env` (mode 0600) — it
does **not** read `~/.aws`, AWS CLI profiles, or SSO sessions. `config.json` holds
only the model id and an optional region. Because Converse is model-agnostic, this
one provider reaches every Bedrock family — Claude, Amazon Nova, Meta Llama,
Mistral, DeepSeek — through the same transport. See ADR
[bedrock-converse-provider.md](../adr/bedrock-converse-provider.md) for the
wire-level design.

This guide assumes you are starting with nothing: no AWS CLI, no `~/.aws`, just an
AWS account.

## Step 1 — Create an AWS access key

You need a long-term IAM access key: an **Access Key ID** (starts with `AKIA…`)
and a **Secret Access Key**. Long-term keys do not expire, so you set them once.

1. Sign in to the [IAM console](https://console.aws.amazon.com/iam/) as an IAM
   user (not the account root user — [AWS recommends against root keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html)).
   If you don't have an IAM user yet, create one under **Users → Create user**.
2. Open the user, go to the **Security credentials** tab.
3. Under **Access keys**, choose **Create access key**. Pick "Command Line
   Interface (CLI)" (or "Other") as the use case and confirm.
4. Copy both the **Access key ID** and the **Secret access key** now — the secret
   is shown only once. (You can download the `.csv` if you prefer.)

The IAM user (or its group/role) needs Bedrock permissions — at minimum
`bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`, plus the
AWS Marketplace permissions in Step 2.

## Step 2 — Enable model access in Bedrock

Access to Bedrock models is [enabled by default](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
in commercial AWS regions, given AWS Marketplace permissions
(`aws-marketplace:Subscribe`, `Unsubscribe`, `ViewSubscriptions`) and a valid
payment method on the account.

The one exception: **Anthropic (Claude) models require a one-time First Time Use
form**, submitted once per account or AWS Organization. Submit it by opening an
Anthropic model in the [Amazon Bedrock console](https://console.aws.amazon.com/bedrock/)
→ **Model access**. A first call may return `AccessDeniedException` for a minute
or two while the subscription finalizes — retry.

## Step 3 — Add the provider in Gini

### Web

Open **Settings → Add provider → Amazon Bedrock**. Paste your **Access Key ID**
and **Secret Access Key**, pick a model (or enter a custom inference-profile id),
choose an optional region, and save. Gini writes the two keys to
`~/.gini/secrets.env` and starts signing requests with them immediately — no
restart needed.

### CLI

Run `gini setup` and pick **Amazon Bedrock** from the provider list. It prompts
for the Access Key ID and Secret Access Key (saved to `~/.gini/secrets.env`), then
the model and an optional region.

To set the model or region without re-running setup:

```bash
gini provider set bedrock us.anthropic.claude-opus-4-8 --aws-region us-east-1
```

The model id is a Bedrock [cross-region inference-profile id](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)
(for example `us.amazon.nova-pro-v1:0`, `us.meta.llama4-scout-17b-instruct-v1:0`).
`--aws-region` is optional; when omitted Gini resolves `AWS_REGION` /
`AWS_DEFAULT_REGION`, then falls back to `us-east-1`. `gini provider set` only
updates the model and region — enter the keys through the web form or `gini setup`.

### Providing the keys as environment variables

If you'd rather not paste keys into a form, you can export them in the shell that
launches Gini instead:

```bash
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
```

Gini reads these from the environment at call time. To survive a gateway restart,
add the same lines (without `export`) to `~/.gini/secrets.env` — which is exactly
what the web form and `gini setup` write for you.

## Re-authentication

When a chat turn fails with a credential error, Gini marks Bedrock as **Needs
re-authentication** in **Settings → Providers**. Click **Update Amazon Bedrock
credentials** on the row (or the Edit pencil) to open the editor and re-enter your
Access Key ID and Secret Access Key.

A key can stop working if it was **disabled or deleted** in the
[IAM console](https://console.aws.amazon.com/iam/) (Security credentials tab), or
if its IAM permissions changed. Create a fresh access key and enter it in Gini.

See ADR [provider-reauth-guidance.md](../adr/provider-reauth-guidance.md) for how
Gini surfaces credential failures.
