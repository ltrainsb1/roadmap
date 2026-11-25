plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.50.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

# github_repository, hosted_zone_id and create_dmarc are declared here for the server, SES and OIDC files that Tasks 7 to 9 add.
# Remove this rule's exemption once they are used.
rule "terraform_unused_declarations" {
  enabled = false
}
