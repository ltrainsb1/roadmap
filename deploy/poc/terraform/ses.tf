# Email: SES sends from the domain, and bounce and complaint events flow SES -> SNS -> SQS for the worker to read.

locals {
  mail_from_domain = "mail.${var.domain}"
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# Easy DKIM: three CNAMEs, one per token.
resource "aws_route53_record" "dkim" {
  count = 3

  zone_id = var.hosted_zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 300
  records = ["${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = var.hosted_zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = 300
  records = ["10 feedback-smtp.${var.region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = var.hosted_zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "dmarc" {
  count = var.create_dmarc ? 1 : 0

  zone_id = var.hosted_zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 300
  records = ["v=DMARC1; p=quarantine; adkim=s; aspf=r"]
}

resource "aws_sesv2_configuration_set" "main" {
  configuration_set_name = "roadmap-poc"

  reputation_options {
    reputation_metrics_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sesv2_account_suppression_attributes" "main" {
  suppressed_reasons = ["BOUNCE", "COMPLAINT"]
}

resource "aws_sns_topic" "ses_events" {
  name              = "roadmap-poc-ses-events"
  kms_master_key_id = aws_kms_key.main.arn
}

resource "aws_sns_topic_policy" "ses_events" {
  arn = aws_sns_topic.ses_events.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SesPublishesForThisConfigurationSet"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.ses_events.arn
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnEquals    = { "aws:SourceArn" = aws_sesv2_configuration_set.main.arn }
      }
    }]
  })
}

resource "aws_sesv2_configuration_set_event_destination" "sns" {
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name
  event_destination_name = "bounces-and-complaints"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]

    sns_destination {
      topic_arn = aws_sns_topic.ses_events.arn
    }
  }

  depends_on = [aws_sns_topic_policy.ses_events]
}

resource "aws_sqs_queue" "ses_events_dlq" {
  name                      = "roadmap-poc-ses-events-dlq"
  kms_master_key_id         = aws_kms_key.main.arn
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "ses_events" {
  name                       = "roadmap-poc-ses-events"
  kms_master_key_id          = aws_kms_key.main.arn
  receive_wait_time_seconds  = 0
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 60

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ses_events_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_policy" "ses_events" {
  queue_url = aws_sqs_queue.ses_events.url

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TheTopicSends"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.ses_events.arn
      Condition = {
        ArnEquals = { "aws:SourceArn" = aws_sns_topic.ses_events.arn }
      }
    }]
  })
}

# Raw delivery: the SQS body is the SES event JSON itself, which is what the worker parses.
resource "aws_sns_topic_subscription" "ses_events" {
  topic_arn            = aws_sns_topic.ses_events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.ses_events.arn
  raw_message_delivery = true

  depends_on = [aws_sqs_queue_policy.ses_events]
}
