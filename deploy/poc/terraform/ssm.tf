# Secrets are generated as ephemeral values and written with value_wo, so they never reach the plan or the state.
# Raising var.secret_version writes new ones. Never raise it for totp-enc-key: every enrolled authenticator would stop working.

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
  value_wo_version = var.secret_version
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
  value_wo_version = var.secret_version
}

# The host's render-env reads these (deploy/poc/host/env-map). ses-configuration-set and ses-events-queue-url come from Task 8.
resource "aws_ssm_parameter" "setting" {
  for_each = {
    "domain"        = var.domain
    "app-origin"    = "https://${var.domain}"
    "mail-from"     = "no-reply@${var.domain}"
    "aws-region"    = var.region
    "s3-bucket"     = local.bucket_names.files
    "backup-bucket" = local.bucket_names.backups
    "registry"      = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com"
  }

  name  = "/roadmap/poc/${each.key}"
  type  = "String"
  value = each.value
}
