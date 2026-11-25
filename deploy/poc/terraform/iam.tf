resource "aws_iam_role" "server" {
  name = "roadmap-poc-server"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_instance_profile" "server" {
  name = "roadmap-poc-server"
  role = aws_iam_role.server.name
}

resource "aws_iam_role_policy_attachment" "server_ssm" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# What the server needs from its own account. The SES and SQS rights are separate aws_iam_role_policy
# resources on this role (ses.tf), so this policy holds neither. Its KMS statement also covers reading the encrypted queue.
resource "aws_iam_role_policy" "server" {
  name = "roadmap-poc-server"
  role = aws_iam_role.server.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = ["*"]
      },
      {
        Sid    = "EcrPull"
        Effect = "Allow"
        Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = [
          for k in sort(keys(aws_ecr_repository.app)) : "arn:aws:ecr:${var.region}:${local.account_id}:repository/roadmap-${k}"
        ]
      },
      {
        Sid      = "ReadSettings"
        Effect   = "Allow"
        Action   = ["ssm:GetParametersByPath"]
        Resource = ["arn:aws:ssm:${var.region}:${local.account_id}:parameter/roadmap/poc/*"]
      },
      {
        Sid      = "FilesBucketObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = ["arn:aws:s3:::${local.bucket_names.files}/*"]
      },
      {
        Sid      = "BackupWrite"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = ["arn:aws:s3:::${local.bucket_names.backups}/mongo/*"]
      },
      {
        Sid      = "BackupRead"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["arn:aws:s3:::${local.bucket_names.backups}/mongo/*"]
      },
      {
        Sid      = "ReleasesRead"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["arn:aws:s3:::${local.bucket_names.releases}/*"]
      },
      {
        Sid      = "TheKey"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:Encrypt"]
        Resource = [aws_kms_key.main.arn]
      },
    ]
  })
}

resource "aws_iam_role" "dlm" {
  name = "roadmap-poc-dlm"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

# DLM snapshots encrypted volumes: its service-linked access to the key has to be granted explicitly here.
resource "aws_iam_role_policy" "dlm_key" {
  name = "roadmap-poc-dlm-key"
  role = aws_iam_role.dlm.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:CreateGrant", "kms:DescribeKey", "kms:Decrypt", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncrypt*"]
      Resource = [aws_kms_key.main.arn]
    }]
  })
}

# Sending mail: only from the domain identity, and only through the configuration set.
resource "aws_iam_role_policy" "server_email" {
  name = "roadmap-poc-server-email"
  role = aws_iam_role.server.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SendFromTheDomain"
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = [aws_sesv2_email_identity.domain.arn, aws_sesv2_configuration_set.main.arn]
      },
      {
        # The API's "Send emails again" route removes one address from the account suppression list.
        # SES offers no resource to scope this to.
        Sid      = "SendEmailsAgain"
        Effect   = "Allow"
        Action   = ["ses:DeleteSuppressedDestination"]
        Resource = ["*"]
      },
    ]
  })
}

# The worker reads bounce and complaint events from this queue only.
resource "aws_iam_role_policy" "server_events_queue" {
  name = "roadmap-poc-server-events-queue"
  role = aws_iam_role.server.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadSesEvents"
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.ses_events.arn]
    }]
  })
}
