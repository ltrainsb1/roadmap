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

override_resource {
  target          = aws_instance.server
  override_during = plan
  values = {
    id  = "i-0abc123def4567890"
    arn = "arn:aws:ec2:us-east-1:111122223333:instance/i-0abc123def4567890"
  }
}

override_resource {
  target          = aws_iam_openid_connect_provider.github
  override_during = plan
  values = {
    arn = "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
  }
}

variables {
  domain         = "roadmap.example.com"
  hosted_zone_id = "Z0123456789ABCDEFGHIJ"
}

run "NFR_OIDC_the_deploy_role_trusts_only_the_poc_environment_of_the_repository" {
  command = plan

  assert {
    condition = (
      aws_iam_openid_connect_provider.github.url == "https://token.actions.githubusercontent.com"
      && aws_iam_openid_connect_provider.github.client_id_list == toset(["sts.amazonaws.com"])
    )
    error_message = "The OIDC provider must be GitHub's, with the client id sts.amazonaws.com."
  }

  assert {
    condition     = aws_iam_role.deploy.name == "roadmap-poc-deploy"
    error_message = "The deploy role must be called roadmap-poc-deploy."
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_role.deploy.assume_role_policy).Statement) == 1
      && jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Effect == "Allow"
      && jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity"
      && jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Principal == {
        Federated = "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
      }
    )
    error_message = "Only the GitHub OIDC provider may assume the deploy role, with AssumeRoleWithWebIdentity."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition == {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:ltrainsb1/roadmap:environment:poc"
        }
      }
    )
    error_message = "The trust must require aud sts.amazonaws.com and sub repo:<repository>:environment:poc, nothing wider."
  }
}

run "NFR_OIDC_the_repository_comes_from_the_variable" {
  command = plan

  variables {
    github_repository = "someone/else"
  }

  assert {
    condition = (
      jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]
      == "repo:someone/else:environment:poc"
    )
    error_message = "The sub condition must follow var.github_repository."
  }
}

run "NFR_OIDC_the_deploy_role_has_no_ssm_GetParameter_StartSession_or_iam_action" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.deploy.name == "roadmap-poc-deploy"
    error_message = "The deploy policy must be called roadmap-poc-deploy."
  }

  assert {
    condition = !anytrue([
      for a in flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s.Action]) :
      startswith(a, "iam:") || startswith(a, "ssm:GetParameter") || a == "ssm:StartSession" || a == "*" || endswith(a, ":*")
    ])
    error_message = "The deploy role must not read parameters, open sessions, change IAM, or hold a wildcard action."
  }

  assert {
    condition = (
      sort(flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s.Action]))
      == sort([
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages",
        "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
        "s3:PutObject",
        "kms:GenerateDataKey",
        "ssm:SendCommand",
        "ssm:GetCommandInvocation", "ssm:ListCommandInvocations",
      ])
    )
    error_message = "The deploy role holds exactly the ECR push, releases upload, key, and send-command rights."
  }

  assert {
    condition = (
      flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s.Resource if contains(s.Action, "s3:PutObject")])
      == ["arn:aws:s3:::roadmap-poc-releases-111122223333/releases/*"]
      && flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s.Resource if contains(s.Action, "kms:GenerateDataKey")])
      == ["arn:aws:kms:us-east-1:111122223333:key/11111111-2222-3333-4444-555555555555"]
    )
    error_message = "Uploads are limited to releases/* in the releases bucket, and the key is the one KMS key."
  }

  assert {
    condition = (
      flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s.Resource if contains(s.Action, "ecr:PutImage")])
      == [
        "arn:aws:ecr:us-east-1:111122223333:repository/roadmap-api",
        "arn:aws:ecr:us-east-1:111122223333:repository/roadmap-caddy",
        "arn:aws:ecr:us-east-1:111122223333:repository/roadmap-clamav",
        "arn:aws:ecr:us-east-1:111122223333:repository/roadmap-pdf",
      ]
      && flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s.Resource if contains(s.Action, "ecr:GetAuthorizationToken")]) == ["*"]
    )
    error_message = "ECR push is limited to the four repositories; only the sign-in token is on *."
  }

  assert {
    condition = (
      flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s.Resource if contains(s.Action, "ssm:GetCommandInvocation")]) == ["*"]
      && flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s.Action if contains(s.Action, "ssm:GetCommandInvocation")]) == [
        "ssm:GetCommandInvocation", "ssm:ListCommandInvocations",
      ]
    )
    error_message = "Reading command results is on *, and is only GetCommandInvocation and ListCommandInvocations."
  }
}

run "NFR_OIDC_send_command_is_limited_to_AWS_RunShellScript_and_the_one_instance" {
  command = plan

  assert {
    condition = (
      flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s.Resource if contains(s.Action, "ssm:SendCommand")])
      == [
        "arn:aws:ssm:us-east-1::document/AWS-RunShellScript",
        "arn:aws:ec2:us-east-1:111122223333:instance/i-0abc123def4567890",
      ]
    )
    error_message = "ssm:SendCommand must name the AWS-RunShellScript document and this one instance, by ARN."
  }

  assert {
    condition     = !can(regex("instance/\\*", aws_iam_role_policy.deploy.policy))
    error_message = "No instance wildcard."
  }
}
