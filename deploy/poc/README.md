# Roadmap POC: how to run it

This is the runbook for the proof-of-concept server on AWS. You follow it once to set everything up. After that you use the later sections when something changes or breaks.

One server runs the whole app with Docker Compose. Terraform builds the AWS side. A GitHub workflow that you start by hand puts new versions on the server. Nothing deploys on its own.

Run every command from the repository root unless a step says otherwise. Replace anything in `<angle brackets>`.

## What you need

- An AWS account used for this POC and nothing else. The server's role has AWS's `AmazonSSMManagedInstanceCore` policy (for Session Manager and Run Command), which lets it read every SSM parameter in the account, not only the POC's own. In an account of its own, those are the only parameters there are.
- A Route 53 hosted zone that holds the domain you want to use.
- The AWS CLI, signed in as an administrator.
- Terraform 1.11 or newer.
- The `gh` CLI, signed in to GitHub with rights to change this repository's settings.

## Set it up

### 1. Create the state bucket

Terraform keeps its record of what it built in an S3 bucket. This step makes that bucket. It uses its own small state file on your machine (ignored by git).

```bash
terraform -chdir=deploy/poc/terraform/bootstrap init
terraform -chdir=deploy/poc/terraform/bootstrap apply
terraform -chdir=deploy/poc/terraform/bootstrap output -raw state_bucket
```

Write down the bucket name. If you use a region other than `us-east-1`, add `-var region=<region>` to the `apply`, and use the same region everywhere below.

### 2. Build the AWS side

Put your settings in a file, so later commands do not need them. The file is ignored by git. The secret version numbers are not in it. They are in `secret-versions.auto.tfvars`, which is committed (step 12).

```bash
cat > deploy/poc/terraform/terraform.tfvars <<'EOF'
domain         = "roadmap.example.com"
hosted_zone_id = "Z0123456789ABCDEFGHIJ"
EOF
```

If this repository lives under a different GitHub name than `ltrainsb1/roadmap`, add a line `github_repository = "<owner>/<name>"`. Only that repository can deploy.

Then start Terraform and build everything. Read the plan before you type `yes`.

```bash
terraform -chdir=deploy/poc/terraform init -backend-config=bucket=<state bucket> -backend-config=region=us-east-1
terraform -chdir=deploy/poc/terraform apply
```

Terraform points the domain at the server with an A record only. The POC is reached over IPv4 only, on purpose: Docker passes IPv6 connections to Caddy through its own proxy, so every IPv6 visitor would look like one address to Caddy and to the API's rate limits.

The server needs about five minutes after this to install Docker. Wait until AWS can reach it. This prints `Online` when it is ready:

```bash
aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=$(terraform -chdir=deploy/poc/terraform output -raw instance_id)" \
  --query 'InstanceInformationList[0].PingStatus' --output text
```

### 3. Ask AWS to let SES send to everyone

A new SES account starts in the sandbox. In the sandbox, SES sends mail only to addresses you have verified, and only a few messages a day. Until AWS approves you, the app's notification emails reach nobody else.

Ask for production access. AWS usually answers in about a day.

```bash
aws sesv2 put-account-details \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url https://roadmap.example.com \
  --use-case-description "Roadmap is a planning tool for teams. It sends notification emails to people who have an account: assignments, invitations and password setup links. Each email has an unsubscribe link, and the one-click unsubscribe header. Bounces and complaints come back to us through an SES configuration set, and we stop sending to those addresses automatically. We do not send marketing mail." \
  --contact-language EN
```

While you wait, you can verify your own address so you can test. Click the link AWS sends to it.

```bash
aws sesv2 create-email-identity --email-identity you@example.com
```

Check the request later:

```bash
aws sesv2 get-account --query ProductionAccessEnabled
```

### 4. Set up GitHub

The deploy workflow runs in a GitHub environment called `poc`. The AWS role you made in step 2 trusts that environment and nothing else. Create it, then set the six variables the workflow reads. They are repository variables, and none of them is secret.

```bash
gh api --method PUT repos/<owner>/<name>/environments/poc
tf="terraform -chdir=deploy/poc/terraform"
gh variable set AWS_REGION --body us-east-1
gh variable set POC_DEPLOY_ROLE_ARN --body "$($tf output -raw deploy_role_arn)"
gh variable set POC_INSTANCE_ID --body "$($tf output -raw instance_id)"
gh variable set POC_REGISTRY --body "$($tf output -raw registry)"
gh variable set POC_RELEASES_BUCKET --body "$($tf output -raw releases_bucket)"
gh variable set POC_DOMAIN --body roadmap.example.com
```

To make people approve each deploy, open the `poc` environment in the repository settings and add required reviewers.

### 5. Deploy

The workflow builds the four images for arm64, scans them with Trivy, pushes them, uploads the release bundle, tells the server to deploy it, and then checks the site from outside.

```bash
gh workflow run deploy-poc.yml --ref <branch>
gh run list --workflow deploy-poc.yml --limit 1
gh run watch
```

The first deploy is slow. ClamAV loads its virus signatures before it is healthy, and that takes about six minutes.

How a deploy ends:

- It passes: the new release is running and healthy.
- It fails and says it rolled back: the server went back to the release before. Read the output the job printed to see why.
- It fails and there was no earlier release (the very first deploy): the broken stack is left running so you can look at it. Fix the cause and run the workflow again.

You can run the outside check yourself at any time. It only reads.

```bash
scripts/post-deploy-check.sh https://roadmap.example.com
```

### 6. Create the first account

Open a shell on the server. There is no SSH. You go in through AWS Systems Manager.

```bash
aws ssm start-session --target "$(terraform -chdir=deploy/poc/terraform output -raw instance_id)"
```

Inside the session, become root and define a short helper for Docker Compose. The server runs the stack with exactly these arguments. This helper is used in later steps too.

```bash
sudo -i
release=$(cat /opt/roadmap/current)
cd /opt/roadmap/releases/$release
dc() { RELEASE=$release docker compose -p roadmap-poc -f deploy/poc/docker-compose.yml -f deploy/poc/docker-compose.aws.yml --env-file /run/roadmap/compose.env "$@"; }
```

If `/run/roadmap/compose.env` is missing (this happens after a reboot, until the next deploy), make it first:

```bash
/opt/roadmap/bin/render-env "$release"
```

Now create the first account:

```bash
dc exec -T api node dist/cli/bootstrap.js --tenant "<name>" --email <address> --name "<name>"
```

It prints a setup link. Open it in a browser and choose a password and set up an authenticator app. The link works once. Type `exit` twice to leave the session.

### 7. Check it by hand

The script in step 5 cannot do these. They need a signed-in user. Do all of them once after the first deploy, and after any change to the AWS setup.

1. Sign in with the account from step 6.
2. Upload a file to an item, then download it. The download must open the file from S3. If you see an XML error page from `amazonaws.com`, the server's S3 or KMS rights are wrong. Check the files bucket and the server role in `deploy/poc/terraform/iam.tf`.
3. Make a PDF of a snapshot (share a roadmap, then print it to PDF).
4. Turn on a calendar feed and subscribe to it in a calendar app.
5. Assign an item to a person whose address is verified in SES (see step 3 for the sandbox). One notification email must arrive. Click its "Turn off these emails" link, press the button, and check you see "Emails are off."

## Keep it running

### 8. Times and what is kept

Every time below is UTC.

| Time  | What runs |
| ----- | --------- |
| 03:00 | The backup timer dumps MongoDB to the backup bucket (`mongo/<date>.archive.gz`). It writes the dump to `/srv/mongo-backup` first, which is on the root disk, and removes it after the upload. |
| 04:00 | The patch timer installs Amazon Linux security updates. It may reboot the server. After a reboot, MongoDB and the app start again by themselves. |
| 05:00 | Data Lifecycle Manager snapshots the data volume. |

Backups and snapshots are kept for 14 days.

If a nightly job failed, it shows up here:

```bash
systemctl --failed
journalctl -u roadmap-backup.service -n 50
```

Docker keeps its sign-in token for the image registry in `/root/.docker/config.json`. The token lasts 12 hours. Every deploy signs in again, so you never refresh it by hand. If you pull an image by hand and get a sign-in error, run a deploy.

### 9. Restore a backup

This puts one night's dump back into MongoDB. List what exists:

```bash
aws s3 ls s3://$(terraform -chdir=deploy/poc/terraform output -raw backup_bucket)/mongo/
```

Open a session as in step 6. First restore into a spare database and look at it. This leaves the live data alone:

```bash
/opt/roadmap/bin/restore-mongo 2026-11-25 --to roadmap_restore_check
```

To replace the live data (it drops and rewrites the collections it restores):

```bash
/opt/roadmap/bin/restore-mongo 2026-11-25
```

### 10. Restore the whole data volume from a snapshot

Use this when the data volume is damaged or lost. It goes back to the snapshot's moment, up to a day of data.

1. Find the snapshot you want:

   ```bash
   aws ec2 describe-snapshots --owner-ids self \
     --filters Name=tag:Snapshot,Values=roadmap-poc-data \
     --query 'sort_by(Snapshots,&StartTime)[-5:].[SnapshotId,StartTime]' --output table
   ```

2. In a session on the server (step 6), stop the stack, stop Docker and unmount the volume. Docker must be stopped first: its unit (`docker.service`, through the drop-in `wait-for-data.conf`) has `RequiresMountsFor=/srv/mongo`, so systemd would otherwise stop it for you at the unmount, and you would start it by hand later. Stopping `docker.socket` as well keeps a Docker command from starting it again in between.

   ```bash
   dc down
   systemctl stop docker docker.socket
   umount /srv/mongo
   ```

3. Detach the old volume, then make a new one from the snapshot in the same zone. The new volume must carry the same `Snapshot` tag so the daily snapshots keep covering it.

   ```bash
   tf="terraform -chdir=deploy/poc/terraform"
   instance=$($tf output -raw instance_id)
   old=$(aws ec2 describe-volumes --filters Name=tag:Name,Values=roadmap-poc-data --query 'Volumes[0].VolumeId' --output text)
   zone=$(aws ec2 describe-volumes --volume-ids "$old" --query 'Volumes[0].AvailabilityZone' --output text)
   aws ec2 detach-volume --volume-id "$old"
   aws ec2 wait volume-available --volume-ids "$old"
   new=$(aws ec2 create-volume --snapshot-id <snapshot id> --availability-zone "$zone" --volume-type gp3 \
     --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=roadmap-poc-data},{Key=Snapshot,Value=roadmap-poc-data},{Key=Project,Value=roadmap},{Key=Environment,Value=poc}]' \
     --query VolumeId --output text)
   aws ec2 wait volume-available --volume-ids "$new"
   aws ec2 attach-volume --volume-id "$new" --instance-id "$instance" --device /dev/sdf
   aws ec2 wait volume-in-use --volume-ids "$new"
   ```

4. Back in the session, mount it, start Docker, and run the deploy script for the release that was running. The file system keeps the same ID as the snapshot, so the `fstab` line still works. Do not use a bare `docker compose up` here. The images are always pulled, and the registry sign-in lasts only 12 hours, so the pull would fail on a server that has not deployed lately. After a reboot, `/run/roadmap/compose.env` is gone too. The deploy script checks the mount, makes the settings files again, signs in to the registry, starts the stack and waits until it is healthy.

   ```bash
   mount /srv/mongo
   systemctl start docker
   release=$(cat /opt/roadmap/current)
   /opt/roadmap/releases/$release/deploy/poc/host/deploy "$release"
   ```

5. Tell Terraform about the new volume, so the next `apply` does not try to put the old one back.

   ```bash
   $tf state rm aws_volume_attachment.data aws_ebs_volume.data
   $tf import aws_ebs_volume.data "$new"
   $tf import aws_volume_attachment.data "/dev/sdf:$new:$instance"
   $tf plan
   ```

   The plan should show no changes, or only tags. Keep the old volume for a few days, then delete it with `aws ec2 delete-volume --volume-id "$old"`.

### 11. The server does not come back after a reboot

The data volume is mounted by `fstab` with no `nofail`, on purpose. If the volume is not there at boot, the server stops in emergency mode instead of starting MongoDB on the root disk (which would look like an empty database).

How to tell it happened:

- The site is down after a reboot, and the instance shows as running with passing status checks, but it does not appear in Systems Manager (`aws ssm describe-instance-information` does not list it, or says `ConnectionLost`). Emergency mode stops before the SSM agent starts.
- The EC2 serial console shows `You are in emergency mode`.

To fix it, first check in the EC2 console (or with `aws ec2 describe-volumes`) that the data volume is attached as `/dev/sdf`. If it is not, attach it:

```bash
aws ec2 attach-volume --volume-id <data volume id> --instance-id <instance id> --device /dev/sdf
```

Then reboot the instance. If it is attached and the server still stops, use the EC2 serial console (it must be allowed for the account) to read the error and fix `/etc/fstab`. If the console is not available, stop the instance, move its root volume to a helper instance, fix `/etc/fstab` there, and move it back.

### 12. Rotate secrets

Three secrets can be rotated. They live in SSM Parameter Store and Terraform generates them. Each has a version number in `deploy/poc/terraform/secret-versions.auto.tfvars`. Terraform loads that file by itself, and it is committed to git. Raising a number writes a new random value for that secret only. A deploy then reads it.

A version only ever goes up. The file is in git, so a fresh clone has the right numbers. Raise a number in that file and commit it. A lower number counts as a change too, and Terraform would write a new password that no longer matches MongoDB (or, for the unsubscribe key, break every link already sent).

**Never rotate `totp-enc-key`.** It encrypts every person's authenticator secret. A new key makes every enrolled authenticator unreadable, and everyone is locked out of two-step sign-in. It is not in the version map for that reason.

**The unsubscribe key.** Raise it, apply, deploy. Every unsubscribe link in an email already sent stops working.

Change `"unsubscribe-key" = 1` to `2` in `deploy/poc/terraform/secret-versions.auto.tfvars`, then:

```bash
terraform -chdir=deploy/poc/terraform apply
git add deploy/poc/terraform/secret-versions.auto.tfvars
git commit -m "chore(infra): rotate the unsubscribe key"
gh workflow run deploy-poc.yml --ref <branch>
```

**A MongoDB password.** Changing the value in SSM does not change the password inside MongoDB, so you change both. The new value is only known once Terraform has written it, so the steps are below. Plan for a short break, from the moment MongoDB's password changes until the deploy in step 3 finishes, a few minutes. In that time:

- After the app user's password changes, every new database connection from the API and the worker fails to sign in. People may see errors.
- After the root user's password changes, the MongoDB health check (which still uses the old root password) turns unhealthy, and a backup that starts then fails.

That is why step 3 runs the deploy script on the server in the same session, and not the workflow, which can wait for a reviewer.

1. Raise the number for `mongo-app-password` (or `mongo-root-password`) in `secret-versions.auto.tfvars`, then apply and commit. Nothing breaks yet, because the running containers keep their old values.

   ```bash
   terraform -chdir=deploy/poc/terraform apply
   git add deploy/poc/terraform/secret-versions.auto.tfvars
   git commit -m "chore(infra): rotate a MongoDB password"
   ```

2. Open a session as in step 6. Read the new value and set it as that user's password in MongoDB. The command signs in with the old root password that is still inside the running container. For the app user:

   ```bash
   new=$(aws ssm get-parameters-by-path --path /roadmap/poc/ --with-decryption --region us-east-1 \
     --query "Parameters[?Name=='/roadmap/poc/mongo-app-password'].Value" --output text)
   dc exec -T -e NEW="$new" mongo bash -c 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.getSiblingDB(process.env.MONGO_DB).changeUserPassword(\"roadmap_app\", process.env.NEW)"'
   ```

   For the root user, read `/roadmap/poc/mongo-root-password` instead, and use this command:

   ```bash
   dc exec -T -e NEW="$new" mongo bash -c 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.getSiblingDB(\"admin\").changeUserPassword(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.NEW)"'
   ```

3. In the same session, right after the last command, run the deploy script for the release that is running. It makes the settings files again from SSM, signs in to the registry, recreates the containers whose settings changed, and waits until they are healthy. This ends the break.

   ```bash
   release=$(cat /opt/roadmap/current)
   /opt/roadmap/releases/$release/deploy/poc/host/deploy "$release"
   ```

### 13. Upgrade Docker Compose on the live server

The Compose version is pinned in `deploy/poc/terraform/ec2.tf` (`compose_version` and `compose_sha256`). That only shapes a new server. User data runs once, and Terraform ignores changes to it, so editing those lines does not touch the live server. On the live server it is a host step: download, check the SHA-256, install.

Pick a release at least two weeks old. Open a session as in step 6, then:

```bash
version=v5.7.0
cd "$(mktemp -d)"
curl -fsSL -o docker-compose "https://github.com/docker/compose/releases/download/$version/docker-compose-linux-aarch64"
curl -fsSL -o docker-compose.sha256 "https://github.com/docker/compose/releases/download/$version/docker-compose-linux-aarch64.sha256"
cat docker-compose.sha256
sha256sum docker-compose
```

The two hashes must be the same. If they are, install it:

```bash
install -D -m 0755 docker-compose /usr/libexec/docker/cli-plugins/docker-compose
docker compose version
```

Then update `compose_version` and `compose_sha256` in `ec2.tf` to match, so a replacement server gets the same version.

## Cost and tearing down

### 14. What it costs

At list prices, per month:

| Item | About |
| ---- | ----- |
| t4g.large server (2 vCPU, 8 GB) | $49 |
| 50 GB of gp3 disk (30 GB root, 20 GB data) | $4 |
| Public IPv4 address | $3.65 |
| KMS key | $1 |
| S3, ECR, SES and Route 53 | a few dollars |

That is about $60 a month. The PRD said $33. The difference is the larger server, which the memory measurements called for (ClamAV and Chromium can reach 4.5 GiB together), and the charge AWS now makes for every public IPv4 address.

### 15. Tear it down

A plain `terraform destroy` stops on purpose. The data volume has `prevent_destroy`, and the server has termination protection, so nobody deletes the database by accident. The buckets are not emptied for you either.

Only do this when you are sure. It deletes the data.

1. Keep what you need. Run a backup now (`systemctl start roadmap-backup.service` in a session) and copy the file out of the backup bucket.
2. Empty the three buckets (files, backups, releases). They keep old versions, so delete those too. Run this once for each bucket and repeat it if the bucket held more than 1000 objects:

   ```bash
   bucket=<bucket name>
   aws s3api list-object-versions --bucket "$bucket" --output json \
     --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}' > /tmp/versions.json
   aws s3api delete-objects --bucket "$bucket" --delete file:///tmp/versions.json
   ```

3. Delete the images. The repositories are not set to delete with images in them:

   ```bash
   for name in api pdf caddy clamav; do aws ecr delete-repository --repository-name "roadmap-poc-$name" --force; done
   ```

4. In `deploy/poc/terraform/ec2.tf`, delete the `prevent_destroy = true` line in `aws_ebs_volume.data`, and change `disable_api_termination` to `false`. Then apply that change, and destroy.

   ```bash
   terraform -chdir=deploy/poc/terraform apply
   terraform -chdir=deploy/poc/terraform destroy
   ```

5. Delete what Terraform did not make: the snapshots that Data Lifecycle Manager took (find them with the command in step 10) with `aws ec2 delete-snapshot --snapshot-id <id>`. The KMS key is not deleted at once. AWS schedules it for deletion in 30 days and bills it until then.
6. Last, empty and destroy the state bucket the same way as in step 2 of this list, using the bucket from step 1 and `terraform -chdir=deploy/poc/terraform/bootstrap destroy`. If `destroy` refuses because the bucket has versions, empty it first.
