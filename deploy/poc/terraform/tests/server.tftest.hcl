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
  target          = aws_ebs_volume.data
  override_during = plan
  values = {
    id = "vol-0abc123def4567890"
  }
}

variables {
  domain         = "roadmap.example.com"
  hosted_zone_id = "Z0123456789ABCDEFGHIJ"
}

run "NFR_POC_the_instance_is_a_t4g_large_with_IMDSv2_required_and_hop_limit_2" {
  command = plan

  assert {
    condition     = aws_instance.server.instance_type == "t4g.large"
    error_message = "The instance must be a t4g.large."
  }

  assert {
    condition = (
      one(aws_instance.server.metadata_options).http_tokens == "required"
      && one(aws_instance.server.metadata_options).http_put_response_hop_limit == 2
      && one(aws_instance.server.metadata_options).http_endpoint == "enabled"
    )
    error_message = "IMDSv2 must be required, with a hop limit of 2 so containers can reach it."
  }

  assert {
    condition     = aws_instance.server.disable_api_termination == true && aws_instance.server.user_data_replace_on_change == false
    error_message = "The instance must be protected from termination and must not be replaced when user data changes."
  }

  assert {
    condition     = aws_instance.server.ami == "ami-0123456789abcdef0" && aws_instance.server.associate_public_ip_address == true
    error_message = "The instance must use the AL2023 arm64 image and get its own public IPv4 address."
  }
}

run "NFR_POC_the_security_group_allows_only_TCP_80_and_443_in" {
  command = plan

  assert {
    condition = length(local.ingress_rules) == 4 && alltrue([
      for r in values(local.ingress_rules) : r.port == 80 || r.port == 443
    ])
    error_message = "There must be exactly four ingress rules, each on port 80 or 443."
  }

  assert {
    condition = (
      length(aws_vpc_security_group_ingress_rule.web) == 4
      && alltrue([for r in values(aws_vpc_security_group_ingress_rule.web) : r.ip_protocol == "tcp" && r.from_port == r.to_port && contains([80, 443], r.from_port)])
      && length([for r in values(aws_vpc_security_group_ingress_rule.web) : r if r.cidr_ipv4 == "0.0.0.0/0"]) == 2
      && length([for r in values(aws_vpc_security_group_ingress_rule.web) : r if r.cidr_ipv6 == "::/0"]) == 2
    )
    error_message = "Ports 80 and 443 must each be open from 0.0.0.0/0 and ::/0, and nothing else."
  }

  assert {
    condition     = !can(regex("(?m)^\\s*ingress\\s*\\{", file("${path.module}/ec2.tf")))
    error_message = "The group must have no inline ingress rules, so port 22 cannot be open."
  }
}

run "NFR_POC_no_key_pair" {
  command = plan

  assert {
    condition     = !can(regex("(?m)^\\s*key_name\\s*=", file("${path.module}/ec2.tf")))
    error_message = "The instance must have no key pair. Admin access is through SSM."
  }
}

run "NFR_POC_root_and_data_volumes_are_encrypted_with_the_KMS_key" {
  command = plan

  assert {
    condition = (
      one(aws_instance.server.root_block_device).encrypted == true
      && one(aws_instance.server.root_block_device).kms_key_id == aws_kms_key.main.arn
      && one(aws_instance.server.root_block_device).volume_size == 30
      && one(aws_instance.server.root_block_device).volume_type == "gp3"
    )
    error_message = "The root volume must be 30 GB gp3 and encrypted with the key."
  }

  assert {
    condition = (
      aws_ebs_volume.data.encrypted == true
      && aws_ebs_volume.data.kms_key_id == aws_kms_key.main.arn
      && aws_ebs_volume.data.size == 20
      && aws_ebs_volume.data.type == "gp3"
      && aws_ebs_volume.data.tags["Snapshot"] == "roadmap-poc-data"
      && aws_volume_attachment.data.device_name == "/dev/sdf"
    )
    error_message = "The data volume must be 20 GB gp3, encrypted with the key, tagged for snapshots and attached as /dev/sdf."
  }
}

run "NFR_backups_14_days_DLM_keeps_14_daily_snapshots_of_the_data_volume" {
  command = plan

  assert {
    condition = (
      one(aws_dlm_lifecycle_policy.data.policy_details).resource_types == tolist(["VOLUME"])
      && one(aws_dlm_lifecycle_policy.data.policy_details).target_tags["Snapshot"] == "roadmap-poc-data"
    )
    error_message = "The policy must target volumes tagged Snapshot = roadmap-poc-data."
  }

  assert {
    condition = (
      one(one(aws_dlm_lifecycle_policy.data.policy_details).schedule).retain_rule[0].count == 14
      && one(one(aws_dlm_lifecycle_policy.data.policy_details).schedule).create_rule[0].interval == 24
      && one(one(aws_dlm_lifecycle_policy.data.policy_details).schedule).create_rule[0].times == tolist(["05:00"])
    )
    error_message = "Snapshots must be taken daily at 05:00 UTC and 14 kept."
  }

  assert {
    condition     = aws_iam_role_policy_attachment.dlm.policy_arn == "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
    error_message = "The DLM role must use the AWS-managed service role policy."
  }
}

# The inline policy's by-path grant only. AmazonSSMManagedInstanceCore, also on the role, allows
# ssm:GetParameter(s) on every parameter; the runbook asks for an account used for this POC alone.
run "NFR_the_server_role_by_path_grant_is_limited_to_roadmap_poc" {
  command = plan

  assert {
    condition = (
      flatten([for s in jsondecode(aws_iam_role_policy.server.policy).Statement : s.Resource if contains(s.Action, "ssm:GetParametersByPath")])
      == [
        "arn:aws:ssm:us-east-1:111122223333:parameter/roadmap/poc",
        "arn:aws:ssm:us-east-1:111122223333:parameter/roadmap/poc/*",
      ]
    )
    error_message = "ssm:GetParametersByPath must be allowed on exactly /roadmap/poc and /roadmap/poc/*."
  }

  assert {
    condition = (
      flatten([for s in jsondecode(aws_iam_role_policy.server.policy).Statement : s.Action if s.Sid == "TheKey"])
      == ["kms:Decrypt", "kms:GenerateDataKey"]
    )
    error_message = "The server may use the key for Decrypt and GenerateDataKey only (no kms:Encrypt)."
  }

  assert {
    condition = (
      flatten([for s in jsondecode(aws_iam_role_policy.server.policy).Statement : s.Resource if contains(s.Action, "s3:PutObject") && length(s.Action) == 1])
      == ["arn:aws:s3:::roadmap-poc-backups-111122223333/mongo/*"]
    )
    error_message = "The role may put objects in the backup bucket under mongo/ only."
  }

  assert {
    condition     = !can(regex("ses:|sqs:", aws_iam_role_policy.server.policy))
    error_message = "SES and SQS statements belong to Task 8, in their own policy."
  }
}

run "NFR_user_data_holds_no_settings" {
  command = plan

  assert {
    condition     = !strcontains(aws_instance.server.user_data, "roadmap.example.com") && !strcontains(aws_instance.server.user_data, "roadmap-poc-files")
    error_message = "User data must hold neither the domain nor a bucket name (D2)."
  }

  assert {
    condition = toset(flatten(regexall("\\$\\{\\s*([a-z_0-9]+)", file("${path.module}/user-data.sh.tftpl")))) == toset([
      "data_volume_id", "compose_version", "compose_sha256",
    ])
    error_message = "The user data template must take only the data volume id, the Compose version and its SHA-256."
  }

  assert {
    condition     = strcontains(aws_instance.server.user_data, "vol-0abc123def4567890") && !strcontains(aws_instance.server.user_data, "nofail")
    error_message = "The data volume is found by its id, and its fstab entry has no nofail."
  }
}

run "NFR_POC_the_domain_points_at_the_server_over_IPv4_only" {
  command = plan

  assert {
    condition = (
      aws_route53_record.a.name == "roadmap.example.com"
      && aws_route53_record.a.type == "A"
      && aws_route53_record.a.zone_id == "Z0123456789ABCDEFGHIJ"
    )
    error_message = "An A record for the domain must be in the hosted zone."
  }

  assert {
    condition     = !strcontains(file("${path.module}/dns.tf"), "\"AAAA\"")
    error_message = "There must be no AAAA record: Docker's IPv6 port proxy would make every IPv6 visitor one address to Caddy and the API."
  }
}
