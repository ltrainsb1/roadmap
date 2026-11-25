data "aws_caller_identity" "current" {}

# The first zone that offers t4g.large, so the server can start there.
data "aws_ec2_instance_type_offerings" "t4g_large" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = ["t4g.large"]
  }
}

resource "aws_vpc" "main" {
  cidr_block                       = "10.40.0.0/16"
  assign_generated_ipv6_cidr_block = true
  enable_dns_support               = true
  enable_dns_hostnames             = true

  tags = { Name = "roadmap-poc" }
}

# Nothing uses the default security group, so it allows nothing.
resource "aws_default_security_group" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "roadmap-poc-default" }
}

resource "aws_subnet" "public" {
  vpc_id                          = aws_vpc.main.id
  availability_zone               = sort(data.aws_ec2_instance_type_offerings.t4g_large.locations)[0]
  cidr_block                      = "10.40.1.0/24"
  ipv6_cidr_block                 = cidrsubnet(aws_vpc.main.ipv6_cidr_block, 8, 1)
  assign_ipv6_address_on_creation = true
  # No map_public_ip_on_launch: the server (Task 7) sets associate_public_ip_address itself, since there is no NAT.

  tags = { Name = "roadmap-poc-public" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "roadmap-poc" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  route {
    ipv6_cidr_block = "::/0"
    gateway_id      = aws_internet_gateway.main.id
  }

  tags = { Name = "roadmap-poc-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# Free, and keeps S3 traffic off the internet gateway. There is no NAT.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]

  tags = { Name = "roadmap-poc-s3" }
}
