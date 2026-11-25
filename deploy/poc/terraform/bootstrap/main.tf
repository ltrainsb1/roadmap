# Run once by hand, before the main root, to create the bucket that holds its state.
# This root keeps its own state in a local file (terraform.tfstate, ignored in git): it is tiny, and losing it costs one
# `terraform import`. The state bucket uses SSE-S3 because the KMS key lives in the main root, which needs this bucket first.

terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70"
    }
  }
}

variable "region" {
  description = "The AWS region."
  type        = string
  default     = "us-east-1"
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "roadmap"
      Environment = "poc"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  bucket = "roadmap-poc-tfstate-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "state" {
  bucket = local.bucket
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# The state bucket predates the KMS key, so it uses SSE-S3 (decided in the comment at the top of this file).
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# State history is the way back from a bad apply.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {
      prefix = ""
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyNonTls"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        "arn:aws:s3:::${local.bucket}",
        "arn:aws:s3:::${local.bucket}/*",
      ]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.state]
}

output "state_bucket" {
  description = "Pass this to the main root as -backend-config=\"bucket=<this>\"."
  value       = aws_s3_bucket.state.id
}
