FROM mysql:8.4
COPY --chmod=755 deploy/mysql-entrypoint.sh /usr/local/bin/harbor-mysql-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/harbor-mysql-entrypoint.sh"]
CMD ["mysqld", "--socket=/var/run/harbor-mysql/mysql.sock", "--skip-networking=ON"]
