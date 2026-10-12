.PHONY: setup test exec clean
ACTION ?= test_connection

setup:
	bundle install

test:
	bundle exec rspec

# make exec ACTION=actions.list_files.execute INPUT=fixtures/list_files.json
exec:
	bundle exec workato exec $(ACTION) --connector=connector.rb --settings=settings.yaml.enc $(if $(INPUT),--input=$(INPUT),)

clean:
	rm -rf vendor/bundle .rspec_status
