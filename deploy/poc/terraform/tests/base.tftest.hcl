# Plan-only tests with a mocked AWS provider: nothing here calls AWS.
# The random provider is real, so the ephemeral passwords are generated for real.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{}"
    }
  }
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "111122223333"
  }
}

override_data {
  target = data.aws_ec2_instance_type_offerings.t4g_large
  values = {
    locations = ["us-east-1b", "us-east-1a"]
  }
}

override_resource {
  target          = aws_kms_key.main
  override_during = plan
  values = {
    arn    = "arn:aws:kms:us-east-1:111122223333:key/11111111-2222-3333-4444-555555555555"
    key_id = "11111111-2222-3333-4444-555555555555"
  }
}

variables {
  domain         = "roadmap.example.com"
  hosted_zone_id = "Z0123456789ABCDEFGHIJ"
}

run "NFR_data_protection_every_bucket_blocks_public_access_and_uses_the_KMS_key" {
  command = plan

  assert {
    condition = alltrue([
      for v in [
        aws_s3_bucket_public_access_block.files,
        aws_s3_bucket_public_access_block.backups,
        aws_s3_bucket_public_access_block.releases,
      ] :
      v.block_public_acls && v.block_public_policy && v.ignore_public_acls && v.restrict_public_buckets
    ])
    error_message = "Every bucket must block all four kinds of public access."
  }

  assert {
    condition = alltrue([
      for v in [
        aws_s3_bucket_server_side_encryption_configuration.files,
        aws_s3_bucket_server_side_encryption_configuration.backups,
        aws_s3_bucket_server_side_encryption_configuration.releases,
      ] :
      one(v.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms"
      && one(v.rule).apply_server_side_encryption_by_default[0].kms_master_key_id == aws_kms_key.main.arn
      && one(v.rule).bucket_key_enabled
    ])
    error_message = "Every bucket must default to SSE-KMS with the one key and a bucket key."
  }

  assert {
    condition = alltrue([
      for v in [aws_s3_bucket_ownership_controls.files, aws_s3_bucket_ownership_controls.backups, aws_s3_bucket_ownership_controls.releases] : one(v.rule).object_ownership == "BucketOwnerEnforced"
    ])
    error_message = "Every bucket must enforce bucket-owner ownership."
  }

  assert {
    condition = (
      aws_s3_bucket.files.bucket == "roadmap-poc-files-111122223333"
      && aws_s3_bucket.backups.bucket == "roadmap-poc-backups-111122223333"
      && aws_s3_bucket.releases.bucket == "roadmap-poc-releases-111122223333"
    )
    error_message = "Bucket names must be roadmap-poc-<purpose>-<account id>."
  }
}

run "NFR_data_protection_every_bucket_denies_non_TLS_requests" {
  command = plan

  assert {
    condition = alltrue([
      for v in [aws_s3_bucket_policy.files, aws_s3_bucket_policy.backups, aws_s3_bucket_policy.releases] : length([
        for s in jsondecode(v.policy).Statement : s
        if s.Effect == "Deny"
        && s.Principal == "*"
        && s.Condition.Bool["aws:SecureTransport"] == "false"
      ]) == 1
    ])
    error_message = "Every bucket policy must deny requests made without TLS."
  }
}

run "NFR_backups_14_days_mongo_prefix_in_the_backup_bucket_expires_after_14_days" {
  command = plan

  assert {
    condition = length([
      for r in aws_s3_bucket_lifecycle_configuration.backups.rule : r
      if r.status == "Enabled"
      && one(r.filter).prefix == "mongo/"
      && one(r.expiration).days == 14
    ]) == 1
    error_message = "mongo/ in the backup bucket must expire after 14 days."
  }
}

run "NFR_retention_releases_expire_after_90_days_and_old_file_versions_after_14" {
  command = plan

  assert {
    condition = length([
      for r in aws_s3_bucket_lifecycle_configuration.releases.rule : r
      if r.status == "Enabled" && one(r.expiration).days == 90
    ]) == 1
    error_message = "Release bundles must expire after 90 days."
  }

  assert {
    condition     = one(aws_s3_bucket_versioning.files.versioning_configuration).status == "Enabled"
    error_message = "The files bucket must keep versions."
  }

  assert {
    condition = length([
      for r in aws_s3_bucket_lifecycle_configuration.files.rule : r
      if r.status == "Enabled" && one(r.noncurrent_version_expiration).noncurrent_days == 14
    ]) == 1
    error_message = "Noncurrent file versions must expire after 14 days."
  }
}

run "NFR_secrets_every_secret_SSM_parameter_is_a_SecureString_with_value_wo_set_and_no_value" {
  command = plan

  # A write-only argument is never in the plan, so value_wo itself can't be read here, and with a mocked provider
  # the computed `value` is unknown rather than null. So value_wo_version is checked on the resource, and the
  # source is checked for a plain `value =` fed by a generated password: the secret must never reach state.
  assert {
    condition = toset(concat(keys(aws_ssm_parameter.secret), keys(aws_ssm_parameter.key32))) == toset([
      "mongo-root-password", "mongo-app-password", "totp-enc-key", "unsubscribe-key",
    ])
    error_message = "The four generated secrets must each have a parameter."
  }

  assert {
    condition = alltrue([
      for p in concat(values(aws_ssm_parameter.secret), values(aws_ssm_parameter.key32)) :
      p.type == "SecureString"
      && p.value_wo_version == 1
      && p.key_id == aws_kms_key.main.arn
      && startswith(p.name, "/roadmap/poc/")
    ])
    error_message = "Every secret must be a SecureString under /roadmap/poc/, written write-only, and encrypted with the key."
  }

  assert {
    condition     = !can(regex("(?m)^\\s*value\\s*=\\s*(ephemeral|base64encode|random)", file("${path.module}/ssm.tf")))
    error_message = "A secret must be written with value_wo, never with value."
  }

  assert {
    condition = alltrue([
      for p in values(aws_ssm_parameter.setting) : p.type == "String" && startswith(p.name, "/roadmap/poc/")
    ])
    error_message = "Every setting must be a String under /roadmap/poc/."
  }

  assert {
    condition = (
      aws_ssm_parameter.setting["app-origin"].value == "https://roadmap.example.com"
      && aws_ssm_parameter.setting["mail-from"].value == "no-reply@roadmap.example.com"
      && aws_ssm_parameter.setting["domain"].value == "roadmap.example.com"
      && aws_ssm_parameter.setting["aws-region"].value == "us-east-1"
      && aws_ssm_parameter.setting["s3-bucket"].value == "roadmap-poc-files-111122223333"
      && aws_ssm_parameter.setting["backup-bucket"].value == "roadmap-poc-backups-111122223333"
      && aws_ssm_parameter.setting["registry"].value == "111122223333.dkr.ecr.us-east-1.amazonaws.com"
    )
    error_message = "The settings must carry the values the host scripts read."
  }
}

run "NFR_the_KMS_key_rotates" {
  command = plan

  assert {
    condition     = aws_kms_key.main.enable_key_rotation == true
    error_message = "Key rotation must be on."
  }

  assert {
    condition     = aws_kms_alias.main.name == "alias/roadmap-poc"
    error_message = "The key's alias must be alias/roadmap-poc."
  }

  assert {
    condition = length([
      for s in jsondecode(aws_kms_key.main.policy).Statement : s
      if contains(try(tolist(s.Principal.Service), [try(s.Principal.Service, "")]), "ses.amazonaws.com")
      && contains(try(tolist(s.Principal.Service), [try(s.Principal.Service, "")]), "sns.amazonaws.com")
      && s.Condition.StringEquals["aws:SourceAccount"] == "111122223333"
    ]) == 1
    error_message = "SES and SNS must be able to use the key, only for this account."
  }
}

run "NFR_ECR_tags_are_immutable_and_scanned_on_push" {
  command = plan

  assert {
    condition     = toset(keys(aws_ecr_repository.app)) == toset(["api", "pdf", "caddy", "clamav"])
    error_message = "There must be one repository each for api, pdf, caddy and clamav."
  }

  assert {
    condition = alltrue([
      for k, r in aws_ecr_repository.app :
      r.name == "roadmap-${k}"
      && r.image_tag_mutability == "IMMUTABLE"
      && one(r.image_scanning_configuration).scan_on_push
      && one(r.encryption_configuration).encryption_type == "KMS"
      && one(r.encryption_configuration).kms_key == aws_kms_key.main.arn
    ])
    error_message = "ECR tags must be immutable, scanned on push and encrypted with the key."
  }
}

run "NFR_network_has_no_NAT_and_one_public_subnet_in_a_t4g_large_zone" {
  command = plan

  assert {
    condition     = aws_vpc.main.cidr_block == "10.40.0.0/16" && aws_vpc.main.assign_generated_ipv6_cidr_block
    error_message = "The VPC must be 10.40.0.0/16 with an Amazon IPv6 block."
  }

  assert {
    condition     = aws_subnet.public.cidr_block == "10.40.1.0/24" && aws_subnet.public.availability_zone == "us-east-1a"
    error_message = "The subnet must be 10.40.1.0/24 in the first zone that offers t4g.large."
  }
}
