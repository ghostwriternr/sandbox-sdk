CC = gcc
CFLAGS = -shared -fPIC -O2 -Wall
LDFLAGS = -ldl

.PHONY: all clean

all: /lib/universal_router.so

/lib/universal_router.so: universal_router.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f /lib/universal_router.so