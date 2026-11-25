output "registry" {
  description = "The ECR registry host."
  value       = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com"
}

output "releases_bucket" {
  value = aws_s3_bucket.releases.id
}

output "files_bucket" {
  value = aws_s3_bucket.files.id
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.id
}

output "kms_key_arn" {
  value = aws_kms_key.main.arn
}
