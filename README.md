# 1Glam Docker - ERPNext Deployment

This repository contains Docker configuration for running ERPNext v15.

## Quick Start

1. Clone this repository:
   ```
   git clone https://github.com/Chinmayverma1602/1glamDocker.git
   cd 1glamDocker
   ```

2. Start the Docker containers:
   ```
   docker-compose -f frappe_docker/pwd.yml up -d
   ```

3. Access ERPNext at http://localhost:8080

## Default Credentials

- Site: glamnew.localhost
- Username: Administrator
- Password: admin

## Components

- ERPNext v15.59.0
- MariaDB 10.6
- Redis 6.2
- Nginx as frontend

## Stopping the Server

```
docker-compose -f frappe_docker/pwd.yml down
```

## License

ERPNext is licensed under GNU/GPLv3. 