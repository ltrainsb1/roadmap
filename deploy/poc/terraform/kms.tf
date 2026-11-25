# The one customer-managed key: EBS, S3, ECR, SNS, SQS and the SSM SecureStrings all use it.
resource "aws_kms_key" "main" {
  description         = "roadmap-poc"
  enable_key_rotation = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountRoot"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        # Task 8's encrypted SNS topic and SQS queue. SES publishes to the topic, and SNS delivers to the queue.
        Sid       = "SesAndSnsUseTheKeyForThisAccount"
        Effect    = "Allow"
        Principal = { Service = ["ses.amazonaws.com", "sns.amazonaws.com"] }
        Action    = ["kms:GenerateDataKey*", "kms:Decrypt"]
        Resource  = "*"
        Condition = {
          StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
        }
      },
    ]
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/roadmap-poc"
  target_key_id = aws_kms_key.main.key_id
}
