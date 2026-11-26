# GitHub Actions deploys with short-lived credentials from GitHub's OIDC provider. No AWS key is stored anywhere.

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# Only the deploy workflow, running in the poc environment of this repository, can assume this role.
resource "aws_iam_role" "deploy" {
  name = "roadmap-poc-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:poc"
        }
      }
    }]
  })
}

# What a deploy needs and nothing more: push images, upload the bundle, tell the server to deploy and read the
# result. It can't read parameters, open sessions or change infrastructure.
resource "aws_iam_role_policy" "deploy" {
  name = "roadmap-poc-deploy"
  role = aws_iam_role.deploy.id

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
        Sid    = "EcrPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages",
          "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
        ]
        Resource = [
          for k in sort(keys(aws_ecr_repository.app)) : "arn:aws:ecr:${var.region}:${local.account_id}:repository/roadmap-poc-${k}"
        ]
      },
      {
        Sid      = "UploadTheBundle"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = ["arn:aws:s3:::${local.bucket_names.releases}/releases/*"]
      },
      {
        Sid      = "TheKey"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey"]
        Resource = [aws_kms_key.main.arn]
      },
      {
        Sid      = "RunTheDeploy"
        Effect   = "Allow"
        Action   = ["ssm:SendCommand"]
        Resource = ["arn:aws:ssm:${var.region}::document/AWS-RunShellScript", aws_instance.server.arn]
      },
      {
        # These two accept no resource narrower than *.
        Sid      = "ReadTheResult"
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
        Resource = ["*"]
      },
    ]
  })
}
