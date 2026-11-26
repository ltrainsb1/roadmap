terraform {
  # 1.11 added write-only arguments and ephemeral resources in the shape this root uses.
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70" # write-only arguments on aws_ssm_parameter need 6.x
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7" # ephemeral random_password needs 3.7
    }
  }

  # The bucket and region come from -backend-config (the runbook gives the command).
  backend "s3" {
    key          = "poc/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}
