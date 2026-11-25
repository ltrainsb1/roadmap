locals {
  account_id = data.aws_caller_identity.current.account_id

  bucket_names = {
    files    = "roadmap-poc-files-${local.account_id}"
    backups  = "roadmap-poc-backups-${local.account_id}"
    releases = "roadmap-poc-releases-${local.account_id}"
  }
}

# The same five resources for each bucket, written out so a scanner can follow every reference.
resource "aws_s3_bucket" "files" {
  bucket = local.bucket_names.files
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "files" {
  bucket = aws_s3_bucket.files.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
  }
}

resource "aws_s3_bucket_policy" "files" {
  bucket = aws_s3_bucket.files.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyNonTls"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        "arn:aws:s3:::${local.bucket_names.files}",
        "arn:aws:s3:::${local.bucket_names.files}/*",
      ]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  # S3 rejects a policy change made in parallel with the public access block.
  depends_on = [aws_s3_bucket_public_access_block.files]
}


resource "aws_s3_bucket" "backups" {
  bucket = local.bucket_names.backups
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
  }
}

resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyNonTls"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        "arn:aws:s3:::${local.bucket_names.backups}",
        "arn:aws:s3:::${local.bucket_names.backups}/*",
      ]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  # S3 rejects a policy change made in parallel with the public access block.
  depends_on = [aws_s3_bucket_public_access_block.backups]
}


resource "aws_s3_bucket" "releases" {
  bucket = local.bucket_names.releases
}

resource "aws_s3_bucket_public_access_block" "releases" {
  bucket                  = aws_s3_bucket.releases.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "releases" {
  bucket = aws_s3_bucket.releases.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "releases" {
  bucket = aws_s3_bucket.releases.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
  }
}

resource "aws_s3_bucket_policy" "releases" {
  bucket = aws_s3_bucket.releases.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyNonTls"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        "arn:aws:s3:::${local.bucket_names.releases}",
        "arn:aws:s3:::${local.bucket_names.releases}/*",
      ]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  # S3 rejects a policy change made in parallel with the public access block.
  depends_on = [aws_s3_bucket_public_access_block.releases]
}

resource "aws_s3_bucket_versioning" "files" {
  bucket = aws_s3_bucket.files.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {
      prefix = ""
    }

    noncurrent_version_expiration {
      noncurrent_days = 14
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Versioning must be on before a noncurrent-version rule is accepted.
  depends_on = [aws_s3_bucket_versioning.files]
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "expire-mongo-dumps"
    status = "Enabled"

    filter {
      prefix = "mongo/"
    }

    expiration {
      days = 14
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {
      prefix = ""
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "releases" {
  bucket = aws_s3_bucket.releases.id

  rule {
    id     = "expire-bundles"
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
