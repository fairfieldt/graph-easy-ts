#!/usr/bin/env perl
use strict;
use warnings;
use utf8;

use lib 'Graph-Easy-0.76/lib';

use Graph::Easy::Parser;
use Scalar::Util qw(refaddr);

my $file = shift @ARGV // 'Graph-Easy-0.76/t/in/3_joining.txt';

my $parser = Graph::Easy::Parser->new();
my $graph = $parser->from_file($file);
$graph->layout();
# Ensure sizing has run so $node->{w}/$node->{h} are populated.
$graph->as_ascii();

my @edges = $graph->edges();
my %edge_idx;
my $i = 1;
for my $e (@edges) {
  $edge_idx{refaddr($e)} = $i++;
}

print "FILE\t$file\n";
print "FLOW\t" . (defined $graph->{flow} ? $graph->{flow} : '') . "\n";

my $nodes = $graph->{nodes} // {};
for my $name (sort keys %$nodes) {
  my $n = $nodes->{$name};
  my $rank = defined $n->{rank} ? $n->{rank} : '';
  my $x = defined $n->{x} ? $n->{x} : '';
  my $y = defined $n->{y} ? $n->{y} : '';
  my $cx = defined $n->{cx} ? $n->{cx} : '';
  my $cy = defined $n->{cy} ? $n->{cy} : '';
  my $w = defined $n->{w} ? $n->{w} : '';
  my $h = defined $n->{h} ? $n->{h} : '';
  print "NODE\t$name\trank=$rank\tx=$x\ty=$y\tcx=$cx\tcy=$cy\tw=$w\th=$h\n";
}

for my $e (@edges) {
  my $idx = defined $e->{id} ? $e->{id} : $edge_idx{refaddr($e)};
  my $from = $e->{from} ? (defined $e->{from}{name} ? $e->{from}{name} : '') : '';
  my $to = $e->{to} ? (defined $e->{to}{name} ? $e->{to}{name} : '') : '';
  my $start = defined $e->{start} ? $e->{start} : '';
  my $end = defined $e->{end} ? $e->{end} : '';
  print "EDGE\t$idx\t$from\t$to\tstart=$start\tend=$end\n";
}

my $cells = $graph->{cells} // {};
for my $key (
  sort {
    my ($ax, $ay) = split(/,/, $a);
    my ($bx, $by) = split(/,/, $b);
    ($ay <=> $by) || ($ax <=> $bx);
  } keys %$cells
) {
  my ($x, $y) = split(/,/, $key);
  my $c = $cells->{$key};
  my $class = ref($c) // '';

  if ($class && $c->isa('Graph::Easy::Edge::Cell')) {
    my $edge = $c->{edge};
    my $eidx =
      $edge
        ? (defined $edge->{id} ? $edge->{id} : ($edge_idx{refaddr($edge)} // ''))
        : '';
    my $type = defined $c->{type} ? $c->{type} : '';
    my $base = defined $c->{base} ? $c->{base} : '';
    my $flags = defined $c->{flags} ? $c->{flags} : '';
    print "CELL\t$x\t$y\tEDGE\tclass=$class\tedge=$eidx\ttype=$type\tbase=$base\tflags=$flags\n";
    next;
  }

  if ($class && $c->isa('Graph::Easy::Node')) {
    my $name = defined $c->{name} ? $c->{name} : '';
    print "CELL\t$x\t$y\tNODE\tclass=$class\tname=$name\n";
    next;
  }

  if ($class && $c->isa('Graph::Easy::Group')) {
    my $name = defined $c->{name} ? $c->{name} : '';
    print "CELL\t$x\t$y\tGROUP\tclass=$class\tname=$name\n";
    next;
  }

  print "CELL\t$x\t$y\t$class\n";
}
