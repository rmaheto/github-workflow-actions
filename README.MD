# GitHub Actions: copy objects between S3 buckets

An example manually triggered [pipeline](.github/workflows/pipeline.yml) that calls a [local composite action](.github/actions/copy-s3/action.yml), assumes an AWS IAM role through GitHub OIDC, and copies either one object or a bucket/prefix using TypeScript and AWS SDK v3.

## Workflow structure

- [pipeline.yml](.github/workflows/pipeline.yml): manual trigger, user inputs, runner, checkout, and job permissions. Passes the role secret to the local copy action.
- [.github/actions/copy-s3/action.yml](.github/actions/copy-s3/action.yml): operation steps for Node.js setup, dependency installation, strict type-checking, input validation, OIDC authentication, and script execution.
- [scripts/s3/copy.ts](scripts/s3/copy.ts): external TypeScript containing input validation and AWS SDK copy logic. `--validate-only` checks inputs without calling AWS; the normal invocation validates again before copying. It reads `SOURCE_BUCKET`, `DESTINATION_BUCKET`, `SOURCE_KEY`, `DESTINATION_KEY`, and `RECURSIVE` from environment variables.
- [src/shared/logging/logger.ts](src/shared/logging/logger.ts): reusable structured JSON logger (`createLogger('component')`), independent of AWS and GitHub Actions.
- [src/shared/reporting/job-summary.ts](src/shared/reporting/job-summary.ts): writes a GitHub job summary to `GITHUB_STEP_SUMMARY`; does nothing when that variable is unset.
- [scripts/s3/copy.test.ts](scripts/s3/copy.test.ts): tests with mocked SDK calls; no AWS credentials or buckets required.
- [package.json](package.json) and [package-lock.json](package-lock.json): SDK dependency and reproducible installation.
- [tsconfig.json](tsconfig.json): strict checking with erasable TypeScript syntax. Node.js 24 runs scripts directly; `npm run build` checks types without generating output. Sources stay under `scripts/` to retain the operation directory layout.

GitHub requires workflow files directly in `.github/workflows/`; reusable workflows cannot be moved into a `jobs/` subdirectory. Local composite actions let operation steps live in their own directories instead. The pipeline still declares each job's runner and permissions. To add delete later, create `.github/actions/delete-s3/action.yml` and `scripts/s3/delete.ts`, then add a job invoking that action. Define its inputs, scoped IAM permissions, and execution conditions separately; delete is not implemented or authorized by this example.

Checkout retrieves the selected pipeline commit, including its action, scripts, and dependency files. All of these files must exist on the selected branch.

The action's `shell: bash` is only GitHub's command launcher for `npm` and `node`; there is no Bash operation script or inline copy logic.

## Design

- Source and destination bucket names are supplied at run time and must differ.
- Both buckets are in the same AWS account. Authentication uses `us-east-1`.
- Source objects use a customer-managed KMS key. Destination objects use the destination bucket's default SSE-S3 encryption.
- All branches of `rmaheto/github-workflow-actions` may assume the role; tags are excluded.
- No IAM user access keys, local S3 downloads, or AWS resource creation are needed in the workflow. Checkout retrieves only the repository containing the script.
- Copying can overwrite matching destination keys, but never deletes destination-only objects. Recursive copying copies every matching object, not just changed objects.
- Recursive listings are paginated and objects are copied sequentially. Copies above 5 GiB use server-side multipart copying; no object data is downloaded to the runner. Metadata and tags are preserved, but destination encryption uses its bucket default.

## 1. Configure the AWS OIDC provider

Use an AWS administrator identity for these setup steps. If the provider and role already exist, verify/update them rather than creating duplicates.

1. Open **IAM → Identity providers → Add provider**.
2. Select **OpenID Connect**.
3. Set provider URL to `https://token.actions.githubusercontent.com`.
4. Set audience to `sts.amazonaws.com`, then add the provider.

The existing `gihub-actions-oidc` IAM user is not needed by this pipeline. OIDC federates GitHub to an IAM **role**, not an IAM user; do not create GitHub access-key secrets for that user.

## 2. Create or update the IAM role

In **IAM → Roles → Create role**, choose **Web identity**, the GitHub provider, and audience `sts.amazonaws.com`. Configure the repository when prompted. For an existing role, open **Trust relationships → Edit trust policy**.

Use this trust policy, replacing `ACCOUNT_ID`, `OWNER_ID`, and `REPOSITORY_ID` with your actual numeric IDs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:rmaheto@OWNER_ID/github-workflow-actions@REPOSITORY_ID:ref:refs/heads/*"
        }
      }
    }
  ]
}
```

**Match your repository's actual subject format.** GitHub repositories created, renamed, or transferred after July 15, 2026 use immutable IDs; older repositories use the legacy format unless opted in. Check your repository/organization OIDC settings and subject preview. Numeric IDs are also available through the GitHub repository API (`owner.id` and `id`).

For a repository still using the legacy subject format, replace only the `sub` value above with:

```text
repo:rmaheto/github-workflow-actions:ref:refs/heads/*
```

If your organization customizes OIDC subjects, use its actual branch subject format instead. This workflow does not use a GitHub environment.

**All-branch access is intentional:** anyone who can run or modify workflows on a branch in this repository may obtain this role's permissions. Limit repository write access, keep the role narrowly scoped, and do not substitute a broad `repo:*` subject. The branch-only subject excludes tag, pull-request, and environment subjects.

Save the role and record its ARN. Ensure its maximum session duration allows one hour (the workflow requests 3,600 seconds).

## 3. Create the source KMS key and configure S3

1. In **KMS**, select the source bucket's AWS Region. A KMS key must be in the same Region as its bucket.
2. Choose **Customer managed keys → Create key → Symmetric → Encrypt and decrypt**.
3. Give it an alias, for example `alias/github-actions-source-s3`.
4. Assign your administrative identity as key administrator. Retain the default account-administration/IAM-delegation policy; do not replace the complete key policy with the statement below.
5. Allow the copy role to decrypt through S3 by adding this statement to the key policy. Replace `ACCOUNT_ID`, `ROLE_NAME`, and `SOURCE_REGION`.

```json
{
  "Sid": "AllowGitHubRoleToDecryptSourceThroughS3",
  "Effect": "Allow",
  "Principal": {
    "AWS": "arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME"
  },
  "Action": "kms:Decrypt",
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "kms:ViaService": "s3.SOURCE_REGION.amazonaws.com",
      "kms:CallerAccount": "ACCOUNT_ID"
    }
  }
}
```

Use the full role ARN, including any role path. In a KMS key policy, `Resource: "*"` means the key to which that policy is attached. The copy role only reads the source; it does not need source-key `kms:Encrypt` or `kms:GenerateDataKey`.

6. Give the separate identity that uploads source files permission to use the key, including `kms:GenerateDataKey` (and `kms:Decrypt` for multipart uploads). The copy role is not the uploader.
7. In **S3 → source bucket → Properties → Default encryption → Edit**, select **SSE-KMS** and this key's ARN.
8. Upload example objects after enabling encryption. Changing the bucket default does **not** re-encrypt existing objects; re-upload/re-encrypt them separately if necessary. Check object properties to confirm SSE-KMS and the expected key.
9. In the destination bucket's default encryption settings, select **SSE-S3**. The workflow does not pass encryption headers, so S3 uses this destination default rather than preserving the source's KMS encryption.

S3 Bucket Keys may be enabled; the example decrypt policies do not impose object-level encryption-context restrictions that conflict with them. KMS requests, S3 requests, storage, and any applicable transfer charges can incur costs.

## 4. Grant the role least-privilege copy permissions

In **IAM → Roles → your role → Permissions → Add permissions → Create inline policy**, use the following policy after replacing all placeholders. `SOURCE_KMS_KEY_ARN` is the full ARN from KMS, not its alias.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListCopyBuckets",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": [
        "arn:aws:s3:::SOURCE_BUCKET",
        "arn:aws:s3:::DESTINATION_BUCKET"
      ]
    },
    {
      "Sid": "ReadSourceObjects",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::SOURCE_BUCKET/*"
    },
    {
      "Sid": "WriteDestinationObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::DESTINATION_BUCKET/*"
    },
    {
      "Sid": "ReadSourceTagsForCopy",
      "Effect": "Allow",
      "Action": "s3:GetObjectTagging",
      "Resource": "arn:aws:s3:::SOURCE_BUCKET/*"
    },
    {
      "Sid": "WriteDestinationTagsForCopy",
      "Effect": "Allow",
      "Action": "s3:PutObjectTagging",
      "Resource": "arn:aws:s3:::DESTINATION_BUCKET/*"
    },
    {
      "Sid": "DecryptSourceObjects",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "SOURCE_KMS_KEY_ARN",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "s3.SOURCE_REGION.amazonaws.com",
          "kms:CallerAccount": "ACCOUNT_ID"
        }
      }
    }
  ]
}
```

Tag permissions support preserving source tags, including multipart copies. No delete or ACL permissions are granted. Keep S3 Block Public Access enabled.

Runtime bucket inputs **do not grant access**: the role must explicitly allow each source/destination pair and each source KMS key. Extend the resource lists for additional approved buckets rather than granting access to every bucket. Bucket policies, key policies, permission boundaries, and organization policies must not deny the operation.

## 5. Configure GitHub

1. Publish the pipeline, local action, scripts, and dependency files to `rmaheto/github-workflow-actions` on `main`. GitHub requires the `workflow_dispatch` pipeline on the default branch to enable manual runs.
2. Open **Settings → Secrets and variables → Actions → New repository secret**.
3. Add `AWS_ROLE_ARN` with your full role ARN, for example `arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME`.
4. Ensure GitHub Actions is enabled and repository action policies allow `actions/checkout`, `actions/setup-node`, and `aws-actions/configure-aws-credentials`.

No `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or KMS key secret is needed. The workflow requests `id-token: write` to obtain an OIDC token. The SDK automatically uses the temporary credentials exported by the AWS credentials action. The composite action sets up Node.js 24 and installs dependencies with `npm ci`.

## 6. Run the pipeline

Open **Actions → S3 pipeline → Run workflow** and select any branch containing the pipeline, action, scripts, and dependency files.

| Input | Single object example | Recursive prefix example |
| --- | --- | --- |
| Source bucket | Your approved source bucket | Your approved source bucket |
| Destination bucket | Your approved destination bucket | Your approved destination bucket |
| Recursive | Unchecked | Checked |
| Source key | `reports/monthly.csv` | `reports/` |
| Destination key | `archive/monthly.csv` | `archive/` |

- For a single object, source key is required. An empty destination key copies it to the destination root with its basename. A destination ending in `/` is a prefix; otherwise it is the exact destination object key.
- For recursive mode, an empty source key copies the whole bucket. An empty destination key places results at the destination root. Relative paths below the source prefix are preserved: `reports/2026/monthly.csv` becomes `archive/2026/monthly.csv`.
- Keys/prefixes are raw S3 keys, not URLs: omit `s3://bucket/`, do not URL-encode spaces, and do not add a leading `/` unless it is part of the actual key. A source prefix `reports/` avoids unintentionally matching keys beginning with `reports-old`.
- This is a live copy, not a dry run. Start with a small test object. Runs time out after 60 minutes; failures may leave a partially copied destination. Rerunning copies matching objects again.
- This example copies current objects, not version history. Archived objects must be restored before copying.
- Failed multipart copies attempt to abort their upload and report cleanup errors. Configure a destination lifecycle rule to abort incomplete multipart uploads left by cancellation or runner termination.

After a test run, verify the destination object contents and its **Properties → Server-side encryption** (SSE-S3). For recursive mode, check a nested key as well. No AWS resources or copies are created simply by adding these files.

## Local validation

With Node.js 24 or newer, run these commands from the project root:

```sh
npm ci
npm run build
npm test
```

`npm ci` installs the locked dependencies. `npm run build` checks TypeScript types without generating files. `npm test` runs tests covering input handling, single and recursive key mapping, pagination, multipart copy boundaries, metadata/tags, and failure propagation.

Tests mock AWS calls: no AWS credentials, bucket access, or AWS charges are required.

Node.js and npm dependencies still require security updates; TypeScript does not eliminate dependency vulnerabilities. The lockfile makes installs reproducible, not automatically safe. Review dependency updates and run `npm audit` alongside tests; an audit only detects known advisories and is not a security guarantee.

## Logging and job summary

Each log entry is one JSON line with `timestamp` (ISO 8601), `level`, `component`, `message`, and optional `context`. DEBUG and INFO go to stdout; WARN and ERROR go to stderr. Set `LOG_LEVEL` to `DEBUG`, `INFO` (default), `WARN`, or `ERROR`.

- Object keys are logged only at `DEBUG`, since file names may be sensitive. Use it only when needed.
- Fields such as passwords, secrets, tokens, authorization headers, credentials, access keys, and object bodies are redacted by key name (case-insensitive, nested); AWS access key IDs, GitHub tokens, and `Bearer`/`Basic` values are also redacted in text. Circular references and serialization failures never break the transfer.
- Failures log the category (`SourceNotFound`, `SourceLookupFailed`, `SourceListFailed`, `CopyFailed`), operation, AWS HTTP status, and request ID. Only a failed `HeadObject` on the source is reported as a missing source.
- The job summary shows status, buckets, mode, objects and bytes copied, and duration. Encryption is not verified by this job, and the summary says so.

No new AWS permissions are required.

## Run a copy locally

You can run [scripts/s3/copy.ts](scripts/s3/copy.ts) directly without running the GitHub workflow. First install dependencies as shown above.

Use an existing AWS profile with source-read, source KMS-decrypt, and destination-write permissions as described in the IAM policy above. GitHub's OIDC authentication is used only inside GitHub Actions; the local script uses the SDK's standard AWS credential resolution. Authenticate your profile first if it uses SSO or another temporary-credential mechanism.

From the project root, replace these example values with your profile, approved buckets, and object keys:

```sh
export AWS_PROFILE='your-profile'
export AWS_REGION='us-east-1'
export SOURCE_BUCKET='your-source-bucket'
export DESTINATION_BUCKET='your-destination-bucket'
export SOURCE_KEY='reports/monthly.csv'
export DESTINATION_KEY='archive/monthly.csv'
export RECURSIVE='false'
```

Validate inputs without accessing AWS:

```sh
node scripts/s3/copy.ts --validate-only
```

`--validate-only` checks input format and required values. It does not verify AWS credentials, permissions, encryption settings, bucket existence, or object existence, and is not a copy preview.

Then perform the **live copy**, which can overwrite the destination object:

```sh
node scripts/s3/copy.ts
```

For a recursive prefix copy, change the inputs and run again:

```sh
export RECURSIVE='true'
export SOURCE_KEY='reports/'
export DESTINATION_KEY='archive/'
node scripts/s3/copy.ts
```

An empty source key in recursive mode copies the whole bucket. An empty destination key copies to the destination root. The same key-mapping rules, encryption requirements, overwrite behavior, and AWS charges described for the pipeline apply to local runs.

## Troubleshooting

- **Cannot assume role:** check `AWS_ROLE_ARN`, provider audience, the actual OIDC subject format, and the selected branch.
- **S3 AccessDenied:** verify the input buckets are allowlisted, object permissions, and any explicit bucket-policy deny.
- **KMS AccessDenied:** check the key that actually encrypted the source object, key state/Region, role policy, and key policy. Older objects may use a different key.
- **Destination requires KMS:** this example expects SSE-S3. If you change that requirement, add destination-key permissions (`kms:GenerateDataKey` and `kms:Decrypt` for multipart copy) and update its key policy.
- **No objects copied:** confirm the prefix; a recursive copy can succeed with no matching objects.

## References

- [AWS: configure GitHub OIDC](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)
- [GitHub: OIDC with AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- [GitHub: immutable OIDC subject formats](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/)
- [AWS credentials action](https://github.com/aws-actions/configure-aws-credentials)
- [S3 SSE-KMS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html)
- [AWS SDK for JavaScript v3: S3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/)