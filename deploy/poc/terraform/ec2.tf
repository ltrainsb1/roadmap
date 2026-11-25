locals {
  # docker-compose-linux-aarch64 from the docker/compose release, with the SHA-256 the release publishes.
  compose_version = "v5.7.0"
  compose_sha256  = "15861535d14e26555736b49376c95e14bfd94285366c8446bfac7156a972e76f"

  # Exactly these four rules: web traffic only, over IPv4 and IPv6. There is no port 22. Admin access is SSM.
  ingress_rules = {
    http_ipv4  = { port = 80, cidr_ipv4 = "0.0.0.0/0", cidr_ipv6 = null }
    http_ipv6  = { port = 80, cidr_ipv4 = null, cidr_ipv6 = "::/0" }
    https_ipv4 = { port = 443, cidr_ipv4 = "0.0.0.0/0", cidr_ipv6 = null }
    https_ipv6 = { port = 443, cidr_ipv4 = null, cidr_ipv6 = "::/0" }
  }
}

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_security_group" "server" {
  name        = "roadmap-poc-server"
  description = "Web traffic in, everything out"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "roadmap-poc-server" }
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each = local.ingress_rules

  security_group_id = aws_security_group.server.id
  description       = "TCP ${each.value.port} from the internet"
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr_ipv4
  cidr_ipv6         = each.value.cidr_ipv6
}

resource "aws_vpc_security_group_egress_rule" "all_ipv4" {
  security_group_id = aws_security_group.server.id
  description       = "Everything out over IPv4"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "all_ipv6" {
  security_group_id = aws_security_group.server.id
  description       = "Everything out over IPv6"
  ip_protocol       = "-1"
  cidr_ipv6         = "::/0"
}

# MongoDB's data lives here, apart from the root disk, so it can be snapshotted and survives a replaced server.
resource "aws_ebs_volume" "data" {
  availability_zone = aws_subnet.public.availability_zone
  size              = 20
  type              = "gp3"
  encrypted         = true
  kms_key_id        = aws_kms_key.main.arn

  tags = {
    Name     = "roadmap-poc-data"
    Snapshot = "roadmap-poc-data"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "server" {
  ami                  = data.aws_ssm_parameter.al2023_arm64.value
  instance_type        = "t4g.large"
  subnet_id            = aws_subnet.public.id
  iam_instance_profile = aws_iam_instance_profile.server.name

  vpc_security_group_ids = [aws_security_group.server.id]
  ipv6_address_count     = 1
  # The subnet does not hand out public addresses. The server needs one at first boot to reach GitHub, and
  # the Elastic IP below takes over as its stable address.
  associate_public_ip_address = true

  disable_api_termination     = true
  user_data_replace_on_change = false

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    data_volume_id  = aws_ebs_volume.data.id
    compose_version = local.compose_version
    compose_sha256  = local.compose_sha256
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2 # containers reach the instance role through Docker's bridge
  }

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
    kms_key_id  = aws_kms_key.main.arn
  }

  tags = { Name = "roadmap-poc" }

  lifecycle {
    # A newer AL2023 image must never replace the server. Patching is done on the host.
    # User data only shapes a new server: cloud-init runs it once, so a change would stop and start the
    # live server for nothing. A Compose upgrade on a live server is a host step (see the runbook).
    ignore_changes = [ami, user_data]
  }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.server.id
}

resource "aws_eip" "server" {
  domain   = "vpc"
  instance = aws_instance.server.id

  tags = { Name = "roadmap-poc" }
}
