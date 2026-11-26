# Plan-only tests with a mocked AWS provider: nothing here calls AWS.

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

override_data {
  target = data.aws_ssm_parameter.al2023_arm64
  values = {
    value = "ami-0123456789abcdef0"
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

override_resource {
  target          = aws_iam_role.server
  override_during = plan
  values = {
    id = "roadmap-poc-server"
  }
}

override_resource {
  target          = aws_ebs_volume.data
  override_during = plan
  values = {
    id = "vol-0abc123def4567890"
  }
}

override_resource {
  target          = aws_sesv2_email_identity.domain
  override_during = plan
  values = {
    arn = "arn:aws:ses:us-east-1:111122223333:identity/roadmap.example.com"
    dkim_signing_attributes = {
      tokens = ["tokena", "tokenb", "tokenc"]
    }
  }
}

override_resource {
  target          = aws_sesv2_configuration_set.main
  override_during = plan
  values = {
    arn = "arn:aws:ses:us-east-1:111122223333:configuration-set/roadmap-poc"
  }
}

override_resource {
  target          = aws_sns_topic.ses_events
  override_during = plan
  values = {
    arn = "arn:aws:sns:us-east-1:111122223333:roadmap-poc-ses-events"
  }
}

override_resource {
  target          = aws_sqs_queue.ses_events
  override_during = plan
  values = {
    arn = "arn:aws:sqs:us-east-1:111122223333:roadmap-poc-ses-events"
    url = "https://sqs.us-east-1.amazonaws.com/111122223333/roadmap-poc-ses-events"
  }
}

override_resource {
  target          = aws_sqs_queue.ses_events_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:us-east-1:111122223333:roadmap-poc-ses-events-dlq"
    url = "https://sqs.us-east-1.amazonaws.com/111122223333/roadmap-poc-ses-events-dlq"
  }
}

variables {
  domain         = "roadmap.example.com"
  hosted_zone_id = "Z0123456789ABCDEFGHIJ"
}

run "FR_5_SES_sends_through_the_configuration_set_with_bounce_and_complaint_events_to_SNS" {
  command = plan

  assert {
    condition = (
      aws_sesv2_configuration_set.main.configuration_set_name == "roadmap-poc"
      && one(aws_sesv2_configuration_set.main.reputation_options).reputation_metrics_enabled == true
      && toset(one(aws_sesv2_configuration_set.main.suppression_options).suppressed_reasons) == toset(["BOUNCE", "COMPLAINT"])
    )
    error_message = "The configuration set roadmap-poc must track reputation and suppress bounces and complaints."
  }

  assert {
    condition = (
      aws_sesv2_configuration_set_event_destination.sns.configuration_set_name == "roadmap-poc"
      && one(aws_sesv2_configuration_set_event_destination.sns.event_destination).enabled == true
      && toset(one(aws_sesv2_configuration_set_event_destination.sns.event_destination).matching_event_types) == toset(["BOUNCE", "COMPLAINT"])
      && one(one(aws_sesv2_configuration_set_event_destination.sns.event_destination).sns_destination).topic_arn == "arn:aws:sns:us-east-1:111122223333:roadmap-poc-ses-events"
    )
    error_message = "Bounce and complaint events must go to the roadmap-poc-ses-events topic."
  }

  assert {
    condition = (
      aws_sesv2_email_identity.domain.email_identity == "roadmap.example.com"
      && one(aws_sesv2_email_identity.domain.dkim_signing_attributes).next_signing_key_length == "RSA_2048_BIT"
      && length(aws_route53_record.dkim) == 3
      && alltrue([for r in aws_route53_record.dkim : r.type == "CNAME" && r.zone_id == "Z0123456789ABCDEFGHIJ"])
      && aws_route53_record.dkim[0].name == "tokena._domainkey.roadmap.example.com"
      && aws_route53_record.dkim[0].records == toset(["tokena.dkim.amazonses.com"])
    )
    error_message = "The domain identity needs RSA 2048 Easy DKIM and its three CNAME records."
  }

  assert {
    condition = (
      aws_sesv2_email_identity_mail_from_attributes.domain.mail_from_domain == "mail.roadmap.example.com"
      && aws_sesv2_email_identity_mail_from_attributes.domain.behavior_on_mx_failure == "USE_DEFAULT_VALUE"
      && aws_route53_record.mail_from_mx.name == "mail.roadmap.example.com"
      && aws_route53_record.mail_from_mx.type == "MX"
      && aws_route53_record.mail_from_mx.records == toset(["10 feedback-smtp.us-east-1.amazonses.com"])
      && aws_route53_record.mail_from_spf.name == "mail.roadmap.example.com"
      && aws_route53_record.mail_from_spf.type == "TXT"
      && aws_route53_record.mail_from_spf.records == toset(["v=spf1 include:amazonses.com ~all"])
    )
    error_message = "The MAIL FROM domain mail.<domain> needs its MX and SPF records and must fall back to the default on MX failure."
  }

  assert {
    condition = (
      strcontains(aws_sns_topic_policy.ses_events.policy, "ses.amazonaws.com")
      && strcontains(aws_sns_topic_policy.ses_events.policy, "111122223333")
      && strcontains(aws_sns_topic_policy.ses_events.policy, "arn:aws:ses:us-east-1:111122223333:configuration-set/roadmap-poc")
      && strcontains(aws_sns_topic_policy.ses_events.policy, "aws:SourceAccount")
      && strcontains(aws_sns_topic_policy.ses_events.policy, "aws:SourceArn")
    )
    error_message = "Only SES, for this account and this configuration set, may publish to the topic."
  }
}

run "FR_5_the_SNS_subscription_to_SQS_uses_raw_message_delivery" {
  command = plan

  assert {
    condition = (
      aws_sns_topic_subscription.ses_events.protocol == "sqs"
      && aws_sns_topic_subscription.ses_events.raw_message_delivery == true
      && aws_sns_topic_subscription.ses_events.topic_arn == "arn:aws:sns:us-east-1:111122223333:roadmap-poc-ses-events"
      && aws_sns_topic_subscription.ses_events.endpoint == "arn:aws:sqs:us-east-1:111122223333:roadmap-poc-ses-events"
    )
    error_message = "The topic must feed the events queue with raw message delivery, so the body is the SES event JSON."
  }

  assert {
    condition = (
      strcontains(aws_sqs_queue_policy.ses_events.policy, "sns.amazonaws.com")
      && strcontains(aws_sqs_queue_policy.ses_events.policy, "sqs:SendMessage")
      && strcontains(aws_sqs_queue_policy.ses_events.policy, "arn:aws:sns:us-east-1:111122223333:roadmap-poc-ses-events")
    )
    error_message = "Only the topic may send to the events queue."
  }
}

run "FR_5_the_events_queue_has_a_dead_letter_queue_after_5_receives" {
  command = plan

  assert {
    condition = (
      aws_sqs_queue.ses_events.name == "roadmap-poc-ses-events"
      && aws_sqs_queue.ses_events.receive_wait_time_seconds == 0
      && aws_sqs_queue.ses_events.message_retention_seconds == 1209600
      && aws_sqs_queue.ses_events.visibility_timeout_seconds == 60
      && aws_sqs_queue.ses_events_dlq.name == "roadmap-poc-ses-events-dlq"
    )
    error_message = "The events queue must use short polling, keep messages 14 days and hide them for 60 seconds."
  }

  assert {
    condition = (
      jsondecode(aws_sqs_queue.ses_events.redrive_policy).maxReceiveCount == 5
      && jsondecode(aws_sqs_queue.ses_events.redrive_policy).deadLetterTargetArn == "arn:aws:sqs:us-east-1:111122223333:roadmap-poc-ses-events-dlq"
    )
    error_message = "After 5 receives a message must move to the dead-letter queue."
  }
}

run "FR_5_the_account_suppression_list_covers_bounces_and_complaints" {
  command = plan

  assert {
    condition     = toset(aws_sesv2_account_suppression_attributes.main.suppressed_reasons) == toset(["BOUNCE", "COMPLAINT"])
    error_message = "The account suppression list must cover bounces and complaints."
  }
}

run "NFR_data_protection_the_topic_and_both_queues_use_the_KMS_key" {
  command = plan

  assert {
    condition = (
      aws_sns_topic.ses_events.kms_master_key_id == aws_kms_key.main.arn
      && aws_sqs_queue.ses_events.kms_master_key_id == aws_kms_key.main.arn
      && aws_sqs_queue.ses_events_dlq.kms_master_key_id == aws_kms_key.main.arn
    )
    error_message = "The topic, the events queue and the dead-letter queue must be encrypted with the KMS key."
  }
}

run "the_server_role_can_send_only_from_the_domain_identity" {
  command = plan

  assert {
    condition = (
      flatten([for s in jsondecode(aws_iam_role_policy.server_email.policy).Statement : s.Resource if contains(s.Action, "ses:SendEmail")])
      == [[
        "arn:aws:ses:us-east-1:111122223333:identity/roadmap.example.com",
        "arn:aws:ses:us-east-1:111122223333:configuration-set/roadmap-poc",
      ]][0]
      && aws_iam_role_policy.server_email.role == aws_iam_role.server.id
    )
    error_message = "ses:SendEmail must be allowed on the domain identity and the configuration set only."
  }

  assert {
    condition = (
      alltrue([for s in jsondecode(aws_iam_role_policy.server_email.policy).Statement : !contains(s.Action, "ses:SendEmail") || contains(s.Action, "ses:SendRawEmail")])
      && flatten([for s in jsondecode(aws_iam_role_policy.server_email.policy).Statement : s.Resource if contains(s.Action, "ses:DeleteSuppressedDestination")]) == ["*"]
    )
    error_message = "SendRawEmail goes with SendEmail, and DeleteSuppressedDestination (Send emails again) is allowed on *."
  }

  assert {
    condition = (
      flatten([for s in jsondecode(aws_iam_role_policy.server_events_queue.policy).Statement : s.Action])
      == ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      && flatten([for s in jsondecode(aws_iam_role_policy.server_events_queue.policy).Statement : s.Resource])
      == ["arn:aws:sqs:us-east-1:111122223333:roadmap-poc-ses-events"]
      && aws_iam_role_policy.server_events_queue.role == aws_iam_role.server.id
    )
    error_message = "The role may only receive, delete and read attributes of the events queue."
  }

  assert {
    condition     = !can(regex("ses:|sqs:", aws_iam_role_policy.server.policy))
    error_message = "Task 7's policy must stay free of SES and SQS."
  }
}

run "the_server_reads_the_email_settings_from_SSM" {
  command = plan

  assert {
    condition = (
      aws_ssm_parameter.setting["ses-configuration-set"].value == "roadmap-poc"
      && aws_ssm_parameter.setting["ses-configuration-set"].name == "/roadmap/poc/ses-configuration-set"
      && aws_ssm_parameter.setting["ses-events-queue-url"].value == "https://sqs.us-east-1.amazonaws.com/111122223333/roadmap-poc-ses-events"
      && aws_ssm_parameter.setting["ses-events-queue-url"].type == "String"
    )
    error_message = "The configuration set name and the events queue URL must be String settings under /roadmap/poc/."
  }
}

run "DMARC_is_created_only_when_create_dmarc_is_true" {
  command = plan

  variables {
    create_dmarc = true
  }

  assert {
    condition = (
      length(aws_route53_record.dmarc) == 1
      && aws_route53_record.dmarc[0].name == "_dmarc.roadmap.example.com"
      && aws_route53_record.dmarc[0].type == "TXT"
      && aws_route53_record.dmarc[0].records == toset(["v=DMARC1; p=quarantine; adkim=s; aspf=r"])
    )
    error_message = "With create_dmarc the _dmarc TXT record must carry the policy."
  }
}

run "DMARC_is_not_created_when_create_dmarc_is_false" {
  command = plan

  variables {
    create_dmarc = false
  }

  assert {
    condition     = length(aws_route53_record.dmarc) == 0
    error_message = "Without create_dmarc there must be no DMARC record."
  }
}
