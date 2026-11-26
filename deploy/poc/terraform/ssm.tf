# Secrets are generated as ephemeral values and written with value_wo, so they never reach the plan or the state.
# Each secret has its own version in var.secret_versions; raising one writes a new value for that secret only.
# totp-enc-key is fixed at version 1 and never rotated: every enrolled authenticator would stop working.

ephemeral "random_password" "secret" {
  for_each = toset(["mongo-root-password", "mongo-app-password"])

  length  = 40
  special = false
}

resource "aws_ssm_parameter" "secret" {
  for_each = toset(["mongo-root-password", "mongo-app-password"])

  name             = "/roadmap/poc/${each.key}"
  type             = "SecureString"
  key_id           = aws_kms_key.main.arn
  value_wo         = ephemeral.random_password.secret[each.key].result
  value_wo_version = var.secret_versions[each.key]
}

# These two must decode to exactly 32 bytes: 32 letters and digits, base64 encoded.
# An ephemeral value can't be asserted on in a test, so this is guarded at run time instead.
# The API's key32 check refuses to start with any other length, and the deploy script then rolls back.
ephemeral "random_password" "key32" {
  for_each = toset(["totp-enc-key", "unsubscribe-key"])

  length  = 32
  special = false
}

resource "aws_ssm_parameter" "key32" {
  for_each = toset(["totp-enc-key", "unsubscribe-key"])

  name             = "/roadmap/poc/${each.key}"
  type             = "SecureString"
  key_id           = aws_kms_key.main.arn
  value_wo         = base64encode(ephemeral.random_password.key32[each.key].result)
  value_wo_version = each.key == "totp-enc-key" ? 1 : var.secret_versions[each.key]
}

# The host's render-env reads these (deploy/poc/host/env-map).
resource "aws_ssm_parameter" "setting" {
  for_each = {
    "domain"        = var.domain
    "app-origin"    = "https://${var.domain}"
    "mail-from"     = "no-reply@${var.domain}"
    "aws-region"    = var.region
    "s3-bucket"     = local.bucket_names.files
    "backup-bucket" = local.bucket_names.backups
    "registry"      = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com"

    "ses-configuration-set" = aws_sesv2_configuration_set.main.configuration_set_name
    "ses-events-queue-url"  = aws_sqs_queue.ses_events.url
  }

  name  = "/roadmap/poc/${each.key}"
  type  = "String"
  value = each.value
}
